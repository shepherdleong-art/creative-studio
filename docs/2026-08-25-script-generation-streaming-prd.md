# PRD：脚本生成过程透明化

日期：2026-08-25
状态：待评审 · 2026-08-25 二轮重写（回归第一性原理；实测数据推翻了一轮的优先级排布）· 2026-08-26 三轮修订（回填公司网关实测：推理不透传，思考块对公司用户不可用——设计不变，覆盖预期调整，见 §1.3 / §5.5 / §5.7 第 7 条）
演示原型：`outputs/script-stream-demo.html`（验证了增量 JSON 解析方向可行）

---

## 1. 背景与问题

### 1.1 现状：一个会骗人的百分比

脚本生成面板（`components/ScriptPanel.tsx:879-912`）展示 0-100% 进度条。它**不是假插值**，而是阶段锚点（`lib/script-generation-v3-service.ts:194-293`、`lib/script-generation-v3.ts:1137-1170`）：

- 5% → 27%：分镜图准备（真实进度，按张数）
- 32% / 45%：第 1 次生成中 / 校验中
- 52% / 65% / 72% / 85%：第 2、3 次尝试（修正）
- 92% 保存 → 100% 完成

问题不只是「百分比不准」。项目自己在批量生产模块立过规矩——`lib/batch-production/executors.ts:37`：「不可测的阶段 percent 必须为 null，不允许伪造」。脚本生成违反了同一原则。

同时，后端已经算出来的过程信息全被丢弃：

- 校验未通过的**原因**（口播偏长/偏短、结构问题）已在 `qualification`、`advisories`、`contentCharacterCount` 里，只用于拼修正 prompt，从不告诉用户；
- 模型「看图判断卖点能否被画面承接」的产出（`sellingPointUsage`）同样不可见。

### 1.2 实测：等待时间到底花在哪里

2026-08-25 用本机已配置的**非公司供应商**做了 SSE 直连实测（极简 prompt：「为保温杯写 20 字口播，输出 JSON」）。这是本 PRD 全部优先级判断的依据：

| 供应商 | 模型 | apiStyle | 首个 reasoning | 首个正文 | 总耗时 | reasoning 字数 | 正文字数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 通义千问 | `qwen3.6-max-preview` | openai-compatible | **2.5s** | **64.4s** | 64.9s | **5983** | 71 |
| Gemini | `gemini-3.6-flash` | openai-compatible | 无 | 3.4s | 3.5s | 0 | 16 |
| Kimi | `kimi-k3` | anthropic-messages | **3.6s** | **20.8s** | 20.8s | **1139** | 71 |
| GPT | `gpt-5.5` | openai-responses | 无 | 7.6s | 7.9s | 0 | 65 |
| GPT | `gpt-5.5` | openai-compatible（对照） | 无 | 4.3s | 4.5s | 0 | 65 |

四条结论：

1. **推理模型的等待时间 83–96% 是纯推理段，正文在最后一两秒才吐完。** 两家不同厂商、不同协议的推理模型是同一形态（qwen 96%、kimi 83%），不是个例。这意味着「流式正文预览」在最长的那一段里显示的是一个**空框**——正是要消除的黑箱感，原样保留。
2. **推理流真实可用，两种协议都验过**：`openai-compatible` 侧 2.5 秒起流、760 chunk，`delta` 字段为 `content, reasoning_content, role`，`stream_options: {include_usage: true}` 末块 usage 正常；`anthropic-messages` 侧 3.6 秒起流、351 事件，构成为 `content_block_delta/thinking_delta ×335` + `/text_delta ×9`。
3. **非推理模型形态完全相反**：Gemini 3.4 秒首字、`gpt-5.5` 4.3–7.6 秒首字，都无推理段。设计必须同时吃下两种形态，不能只按一种优化。
   同一个 `gpt-5.5` 走两种协议还有 3 秒差：`/v1/chat/completions` 4.3s 首字，`/v1/responses` 7.6s。协议选择对体感有实际影响，但不构成改配置的理由——两条都在可接受区间。
4. 上面还只是**极简 prompt**。真实脚本生成带多张分镜图的视觉输入、模板约束、卖点清单，推理段只会更长；再叠上最多 2 次修正循环，总时长按分钟计。

> 复现方式：探针脚本不进代码库（临时文件）。要复跑时对 `/v1/chat/completions` 发 `stream: true`，统计首个 `delta.reasoning_content` 与首个 `delta.content` 的到达时刻差即可。
> 交互原型（按本表时间线 1:1 回放，并与现状进度条对照）：`outputs/script-generation-live-view-mock.html`。

### 1.3 供应商覆盖：一个必须纠正的事实

不能只实现 `openai-compatible`。`lib/script-providers/config.ts:138` 是 `dbConfig?.apiStyle || defaults.apiStyle`——**数据库配置覆盖默认值**，所以内置供应商的实际协议要看 `script_providers` 表，不是看 `config.ts` 的默认常量。本机实测：

| 供应商 | 实际 apiStyle | 只做 openai-compatible 的后果 |
| --- | --- | --- |
| `gemini` | openai-compatible | ✅ 有流式 |
| `qwen` | openai-compatible | ✅ 有流式 |
| `kimi` | **anthropic-messages** | ❌ 全程无过程可见 |
| `gpt` | **openai-responses** | ❌ 全程无过程可见 |
| 公司 `GPT-5-6-Luna-Standard` | openai-compatible | ⚠️ 正文有流式；**推理不透传**（2026-08-26 实测，见 §5.7 第 7 条） |

**四个内置供应商有两个拿不到任何流式**，黑箱问题只解决一半。三种 apiStyle 都要接。公司供应商单独一行：它的黑箱不在协议层——流式本身可用——而在上游不吐推理，其推理段覆盖只能靠已用时长计时兜底。

### 1.4 第一性原理

> **用户在任何时刻都不应该面对一个「什么都没发生」的界面，并且随时知道自己已经等了多久。**

这条原则直接给出优先级排序规则：**哪个信号覆盖的等待时间最长，哪个就是 P0。** 按 §1.2 实测数据重排：

| 过程信号 | 覆盖等待时间（推理模型） | 一轮 PRD | 本次 |
| --- | --- | --- | --- |
| 思考过程流式 | **~96%**（仅推理透传供应商；公司供应商为 0%，见 §5.7 第 7 条） | P2 折叠区（理由「CoT 是噪音」） | **P0** |
| 已用时长计时 | **100%** | 未提及 | **P0** |
| 校验反馈卡 | 修正循环全程 | P0 | P0（保留） |
| 流式正文预览 | **~1%** | P0 旗舰功能 | P1 |
| 图片准备计数 | 前置阶段 | 随百分比一起删 | P0（改确定态计数） |

一轮 PRD 把「删掉假精度」当成了目标。删掉是对的，但它没有回答「还要多久」——**删完什么都不补，这一项反而比现在更差**。

## 2. 目标

1. **任何时刻屏幕上都有真实内容在动**：图片准备段有 `N/M` 计数，推理段有思考流，正文段有正文流，修正期有校验结论。
2. **全程可见已用时长**：用诚实的「已等待 42 秒」替代虚假的「45%」。
3. **校验透明**：每次校验的结果与未通过原因可见，用户知道系统在针对什么修正。
4. **覆盖用户实际在用的全部供应商**：三种 apiStyle 都接流式。唯一已确认的过程死角是公司网关的推理段（上游不透传，2026-08-26 实测）——该段由已用时长计时兜底，不再另造信号。
5. 删除百分比进度条与一切虚假精度。

非目标：

- 不改生成逻辑本身（prompt、校验规则、修正循环、落库格式一律不动）；
- 不改其他步骤面板；
- 不做「预计剩余时间」——那是预测，会重新引入虚假精度。已用时长 + 历史参照就够。

## 3. 用户故事

- 点击「生成脚本」后的**每一秒**，我都能看到有东西在动：先是图片一张张处理完，然后是模型的思考在滚动，最后是口播正文一段段写出来。
- 我随时知道已经等了多久。看到「已 42 秒」我心里有数，看到进度条卡在 45% 我只会怀疑它死了。
- 模型在纠结什么我看得见——它在权衡哪个卖点能被画面承接、口播该压到多少字。方向不对我立刻取消，不用等两分钟。
- 每次校验未通过我能看到「为什么」（如：预计口播 49s，目标 20s，上限 22s），并知道系统正在针对这个问题修正。

## 4. 方案总览

**复用现有轮询通道，在进度快照中携带过程信息。**

```text
供应商 SSE 流（三种 apiStyle）
  → lib/script-providers/sse.ts（共享 SSE reader，从 openai-responses 既有实现抽出）
  → 各适配层解析各自的 delta schema（正文 / 推理分流）
  → generateScriptV3 的 onProgress（携带 streamedContent + reasoningTail + validation）
  → script-generation-manager（快照整体替换，无结构改动）
  → GET /api/projects/[id]/script-generation（现有轮询，1000ms → 400ms）
  → ScriptPanel（已用时长 + 阶段行 + 思考块 + 校验卡 + 正文预览）
```

**被否决的替代方案：浏览器 SSE 直连新增流式端点。** 理由：① 需要在 manager 注册表之外再开一条推送通道，刷新/步骤切换后的状态恢复逻辑要重写一遍；② 轮询快照天然携带累积文本，刷新后无缝恢复；③ 本地单用户应用，400ms 轮询配前端打字机缓冲（§5.4.6）的流畅度足够。

## 5. 详细设计

### 5.1 共享 SSE 基础设施 + 三个适配层

**先抽共享模块，不要从零写。** `lib/script-providers/openai-responses.ts:42-105` 已有一套完整、带 abort 处理的 SSE reader（`readSseText` / `readWithAbort` / 行缓冲 / `reader.cancel()` 兜底），且有 `scripts/openai-responses-adapter.test.ts` 罩着。

新建 `lib/script-providers/sse.ts`，把这套读取循环抽出来，暴露：

```ts
export interface SseStreamHandlers {
  onLine(payload: string): void;   // 已剥离 "data:" 前缀、已跳过注释与 [DONE]
}
export async function readSseStream(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  handlers: SseStreamHandlers,
): Promise<void>;
```

`openai-responses.ts` 改为调用共享模块（行为不变，既有测试是回归保护）。三个适配层各自只写 delta schema 的解析：

| apiStyle | 正文 delta | 推理 delta | 备注 |
| --- | --- | --- | --- |
| `openai-compatible` | `choices[0].delta.content` | `choices[0].delta.reasoning_content` | §1.2 已实测确认 |
| `openai-responses` | ✅ `response.output_text.delta`（已实测） | ⚠️ `response.reasoning_summary_text.delta`（**未验**） | 正文流已用 `gpt-5.5` 实测确认；该模型不产出推理，推理字段名仍按官方 schema 实现，见 §5.8 |
| `anthropic-messages` | `content_block_delta` → `text_delta` | `content_block_delta` → `thinking_delta` | ✅ 已实测（kimi-k3）；需 `stream: true` + `thinking: { type: 'enabled', budget_tokens }` |

统一回调契约（三层一致，消费者无需分辨协议）：

- `onTextDelta?(accumulated: string): void` — 回调**累积全文**，不是增量；
- `onReasoningDelta?(accumulated: string): void` — 同上，推理流。

其余不变的部分：

1. **`temperature=1` 红线必须原样穿过流式改造**（背景与三层保障见 `docs/reference/供应商与队列.md`）。公司网关推理模型 `GPT-5-6-Luna-*` 只接受 `temperature=1`，传其他值被上游 400 拒绝、功能直接不可用。流式改造对这条的三个具体要求：
   - **重试体必须保留流式参数**：`openai-compatible.ts:154` 的 `{ ...body, temperature: 1 }` 是在原 body 上展开的，`stream: true` 与 `stream_options` 会被带上。**重构时不要改成重新构造 body**——那是最容易把流式参数弄丢、且只在公司模型上才复现的坑。
   - **无需回滚已流出的内容**：400 判断挂在 `!res.ok` 上，发生在读响应体之前，此时 reader 还没启动、一个 delta 都没发出，`streamedContent` 仍为空。所以「重试时清空已累积文本」是防御性的，不是必需的回滚。流式与非流式在这一点上完全同构。
   - **前置 allowlist 优先于 400 兜底**：`isDefaultTemperatureOnlyModel()` 前缀匹配命中时直接传 1，不会先挨一次 400，因此**正常路径下用户看不到任何异常**。但进程内名单是内存态，重启后未命中前缀的模型仍会先挨一次 400——在流式下这表现为「首字延迟多一个来回」，不是错误，别当 bug 排查。
2. **取消**：fetch 已接 `requestControl.signal`；共享 reader 的 `readWithAbort` 每次迭代检查中断并抛 AbortError，「取消生成」即时生效。
3. **usage 记账**：`openai-compatible` 加 `stream_options: { include_usage: true }`（§1.2 已确认末块返回 usage）；缺失时走现有 `usage: undefined` 容错。`finishLlmUsageCall` 的 `rawOutput` 用累积正文全文，与非流式一致。
4. **解析容错**：半截 JSON 行忽略；流非正常结束且已收到内容，按现有「返回了无效 JSON」语义抛错进修正循环。
5. **降级**：任一适配层若拿不到推理流（模型不是推理模型、或网关不透传），`onReasoningDelta` 从不触发即可，UI 自动不渲染思考块——**不报错、不特判**。Gemini 这类快模型本来就不需要（§1.2：3.4 秒就出正文）。

注册入口 `lib/script-providers/index.ts:110` `completeJson` 增加可选 `onTextDelta` / `onReasoningDelta`，按 `runtime.apiStyle` 分发到对应适配层。

### 5.2 领域层：`lib/script-generation-v3.ts`

1. `CompleteJsonRequest`（`:25-34`）增加 `onTextDelta?` / `onReasoningDelta?`。
2. `ScriptGenerationProgress`（`:36-41`）扩展：

   ```ts
   export interface ScriptGenerationValidationFeedback {
     attempt: number;
     qualification: 'qualified' | 'too_short' | 'too_long' | 'contract_invalid';
     contentCharacterCount: number;
     estimatedNarrationDurationSec: number;
     targetCharacterRange: [number, number];
     advisories: string[];              // 截断至前 3 条
   }
   export interface ScriptGenerationProgress {
     phase: 'preparing' | 'generating' | 'validating' | 'saving' | 'completed';
     percent: number;                   // 保留字段，UI 不再展示（见 §5.8）
     message: string;
     attempt?: number;
     preparedImages?: [number, number]; // 图片准备段真实计数 [已完成, 总数]
     streamedContent?: string;          // 当前 attempt 的累积正文（半截 JSON，仅供展示）
     reasoningTail?: string;            // 推理流尾部（约 1500 字，见下）
     reasoningChars?: number;           // 本 attempt 累计推理字数
     reasoningDoneMs?: number;          // 推理段耗时；未结束时为 undefined
     validation?: ScriptGenerationValidationFeedback;
     history?: ScriptGenerationValidationFeedback[];
   }
   ```

   **为什么 `reasoningTail` 只留尾部而不是全文**：§1.2 实测极简 prompt 就产出 5983 字推理，真实场景（多图视觉 + 模板 + 卖点）按数万字计。400ms 全量轮询会把每次响应推到几十 KB。而 UI 只需要「滚动的最新一行」和展开后的近况——尾部 ~1500 字完全够用，配 `reasoningChars` 显示总量。**完整 CoT 不进快照、不落库。**

3. `generateScriptV3`（`:1120`）生成循环改动：
   - 每次 attempt 开始：发 progress（`phase: 'generating'`，清空 `streamedContent` / `reasoningTail` / `reasoningChars`）；
   - 调 `dependencies.completeJson` 时传入两个回调，把累积文本转发给 `onProgress`——manager 本来就是整体替换 `{...progress}`（`script-generation-manager.ts:246-249`），写快照代价为零，无需节流；
   - 首次收到 `onTextDelta` 时记录 `reasoningDoneMs`（推理段结束的判定点）；
   - `normalizeCandidate` 之后（`:1171-1185`），无论通过与否，把 `validation` 挂到**现有的 `validating` progress 事件**上，**不新增一条 progress**：数据全部现成（`normalized.qualification`、`script.contentCharacterCount`、`script.estimatedNarrationDurationSec`、`budget` 区间、`advisories`）。
     复用而非新增的理由：`scripts/script-generation-v3.test.ts:245-249` 对进度事件序列有 deepEqual 断言（`[generating/1, validating/1, generating/2, validating/2]`），它守的是「进度必须来自真实的模型调用与校验节点」这条原则——新增事件会逼着重写这条断言，等于为了加字段把回归保护拆掉。挂字段则该断言原样成立。
   - `history` 必须**不可变追加**：每次发 progress 时重建数组（`history: [...prevHistory, next]`），**不得**对上一条 progress 里的数组做 `push`。原因见 §5.3。
   - 素材失配（`ScriptMaterialMismatchError`）路径同样先发 validation 再抛错（该信息已在 error details 白名单内，`script-generation-manager.ts:12-20`）。
4. 图片准备段（`script-generation-v3-service.ts:200-207`）：现有回调已经拿到 `(completed, total)`，只是塞进了 `message` 字符串。改为**同时**写 `preparedImages: [completed, total]` 结构化字段，让 UI 能渲染确定态计数条。这是全流程唯一真实可测的进度，不该跟着假百分比一起删。
5. 卖点承接判断（`sellingPointUsage`）在最终校验通过的 validation 卡中附摘要：used / omitted / omitted_no_visual_support 三态。

### 5.3 任务管理与路由

- `lib/script-generation-manager.ts`：**零改动，但附一条前提约束**。progress 整体替换语义自动携带新字段；终态快照保留 10 分钟不变；`startedAt` 已在快照内（`:127`），计时器零后端成本。
  约束来自浅拷贝：manager 的两处快照拷贝（`:123` 读快照、`:248` 写 progress）都是 `{ ...progress }`，因此新增的数组字段 `history` 会在快照与内部状态之间**共享引用**——外部拿到快照后 `push` 一下就能改到内部状态，这与 `scripts/script-generation-manager.test.ts:125`「返回快照必须是拷贝」守的语义相抵触（该断言目前只测标量 `percent`，所以不会变红，但原则已被绕过）。
  处理方式取**在 v3 层不可变重建 history**（§5.2.3），而不是给 manager 补深拷贝：既维持 manager 零改动，也不给每次流式 progress 写入增加一次数组拷贝成本。
- `app/api/projects/[id]/script-generation/route.ts` 与 `lib/script-generation-route-handler.ts`：**零改动**。GET 快照原样序列化。
- 注意点：`streamedContent` 与 `reasoningTail` 都是展示用文本，**只进内存快照，不落库、不参与解析链路**。
- **新增一列（P1）**：`script_drafts` 目前只有 `createdAt`，没有任何耗时记录，所以「上次约用 X 秒」这个参照现在拿不到。走 `CORE_DB_MIGRATIONS` 追加式 `ALTER TABLE` 加 `generationDurationMs INTEGER`，成功落库时写入。**追加在列表末尾，不改已有条目**（AGENTS.md 红线）。

### 5.4 UI：`components/ScriptPanel.tsx`

替换 `:878-912` 的进度条区块为新组件 `ScriptGenerationLiveView`（新建 `components/script-generation-live-view.tsx`，保持 ScriptPanel 体积可控）。自上而下六块，**按 §1.4 的优先级排布**：

1. **状态条（P0）**：`{供应商名} 正在生成脚本` ｜ **已用时长** ｜ 取消按钮。
   时长 = `Date.now() - Date.parse(snapshot.startedAt)`，每秒跳一次，纯前端，后端零改动。超过 30 秒仍无任何流式信号（无推理流且无正文）时追加「推理模型在正文返回前可能有数十秒沉默，属正常现象」——公司模型实测首字节前沉默 34–43s（§5.7 第 7 条）；超过 90 秒再追加「推理模型通常需要 1-2 分钟」。`generationDurationMs` 可用后追加「上次约 1 分 12 秒」——**是参照不是预测**。
2. **阶段指示行（P0）**：pill 序列「准备图片 → 生成中（第 N 次尝试）→ 校验中 →（修正中）」，当前阶段脉冲动画点。图片准备段用 `preparedImages` 渲染确定态 `3/8` 计数（这一段是真进度，可以有条）。颜色一律走设计令牌（`bg-surface-subtle` / `border-hairline` / `text-ink*` / `bg-accent`），不新增硬编码色值（AGENTS.md 外观约定）。
3. **思考块（P0——覆盖 96% 的等待时间）**：`reasoningChars > 0` 时渲染。
   - 折叠态头部：`💭 思考中 · 已 42 秒 · 5983 字` + **最新一行推理文本横向滚动**（取 `reasoningTail` 末行）；
   - 展开：显示 `reasoningTail`（近 ~1500 字），等宽小字号、`text-ink-tertiary`，自动滚到底；
   - 推理结束（`reasoningDoneMs` 有值）后收起为 `💭 已思考 62 秒`，可展开回看；
   - 拿不到推理流时整块不渲染（Gemini 这类快模型直接进第 4 块）。
4. **校验反馈卡列表（P0）**：渲染 `history` + 当前 `validation`：
   - 未通过（橙）：「第 1 次校验未通过：口播偏长（预计 49.1s，目标 20s，上限 22.0s）→ 已发起修正」；
   - 通过（绿）：「校验通过：预计口播 15.8s / 目标 20s」；
   - `contract_invalid`：「返回格式异常，正在要求模型重新输出」；
   - 最终通过时附 `sellingPointUsage` 摘要：「卖点承接：3 用 / 1 画面不足略过」。
5. **流式正文预览（P1）**：增量解析 `streamedContent`，渲染标题 → 封面标题（主｜副）→ 各段「序号 + narration + subtitle」，正在写入的字段带闪烁光标 `▍`。解析器从演示页移植为纯函数模块 `lib/script-stream-preview.ts`（任意截断点不抛异常，已在 demo 验证）。
   **定位调整**：§1.2 证明它只覆盖最后约 1% 的时间，所以它的价值不是「填充等待」而是「最后确认方向对不对」。不要为它做过度设计。
6. **打字机缓冲（P1）**：400ms 整包轮询会让文本一顿一顿地跳。前端维护「已收到」与「已播出」两个游标，按稳定字速播出，追不上时加速收敛。**纯前端，不动架构**，正文与推理流共用同一个缓冲实现。
7. **轮询间隔**：running 期间 1000ms → 400ms（`ScriptPanel.tsx:421`），取消/失败/成功路径不变。
8. 删除：`role="progressbar"` 区块与 `generationProgress.percent` 渲染；`INITIAL_GENERATION_PROGRESS` 类型同步。
   **无障碍语义不能随进度条一起丢**：现有外层容器已带 `aria-live="polite"`（`ScriptPanel.tsx:880`），替换时必须保留，并给阶段指示行补 `role="status"`。思考块的滚动文本要 `aria-hidden`（高频变化会把读屏刷爆），阶段迁移与校验结论才播报。对应契约断言同步迁移，见 §5.6.5。

### 5.5 边界情况

| 场景 | 行为 |
| --- | --- |
| 刷新页面 / 切换步骤后回来 | 轮询恢复快照，正文与 `reasoningTail` 全量重渲染，无缝续上（现有恢复逻辑 `ScriptPanel.tsx:456-464` 不动）。打字机缓冲需识别「快照跳变」直接吐完，不要从头重播 |
| 生成中点取消 | 共享 reader 立即中断 → AbortError 沿现有链路上抛 → cancelled 静默恢复（现有语义不变） |
| 修正循环开始新 attempt | 正文与推理流清空重流，上一轮的校验卡保留在反馈列表里 |
| 非推理模型（Gemini） | 无推理流 → 思考块不渲染；3-4 秒就进正文，正文预览成为主要信号 |
| 推理模型但网关不透传推理 | 同上，思考块不渲染。此时 96% 的等待只剩计时器兜底——**这是本方案的能力下限，也是计时器必须是 P0 的原因**。**公司 `GPT-5-6-Luna-Standard` 实测即此形态（2026-08-26）：推理段首字节前沉默 34–43s，期间正文亦为空** |
| 网关不支持 `stream_options` | usage 缺失走现有容错；正文与推理 delta 不受影响 |
| 网关不支持 stream 直接报错 | 走现有错误处理（HTTP 错误 → 抛错 → 失败面板），不自动降级重试非流式（保持行为可预期） |
| 流式中途 JSON 截断（网络断开） | 按「返回了无效 JSON」语义进修正循环，与现有解析级失败同路径（`script-generation-v3.ts:1156-1163`） |
| 停机（shutdown） | manager 的 AbortController 广播现有逻辑不变；流式 reader 同样被 abort |

### 5.6 测试计划

改动模块对应测试（AGENTS.md：改哪个模块跑同名测试）：

1. **新增 `scripts/script-provider-sse.test.ts`**：共享 reader 的行缓冲、`[DONE]`、注释行、跨 chunk 断行、abort 中断、异常提前结束。
2. **新增 `scripts/script-provider-stream-adapters.test.ts`**：三种 apiStyle 各 mock 一份 SSE ReadableStream →
   - 断言 `onTextDelta` / `onReasoningDelta` 逐次回调累积全文、各自分流不串台；
   - `openai-compatible` 的 temperature 400 特征 → 重试后正常流式，且回调文本不含第一次的内容；**并断言重试请求体同时保留 `stream: true` 与 `stream_options`、`temperature` 为 1**（这条是 `GPT-5-6-Luna-*` 唯一的自动化防线，公司网关在 CI 里不可达）；
   - `isDefaultTemperatureOnlyModel()` 命中的模型（如 `GPT-5-6-Luna-Standard`）→ 首次请求就带 `temperature: 1` 且带流式参数，**不产生 400 往返**；
   - 只有正文没有推理时 `onReasoningDelta` 从不触发（降级路径）；
   - usage 记账被调用。
3. **回归 `scripts/openai-responses-adapter.test.ts`**：抽共享模块后行为必须不变——这是重构的安全网，**先跑通再改别的**。
4. **扩展 `scripts/script-generation-v3.test.ts`**：注入带双回调的 fake completeJson → 断言 generating 阶段 progress 携带 `streamedContent` / `reasoningTail` / `reasoningChars`；`reasoningTail` 超长时只保尾部且 `reasoningChars` 记全量；首个正文 delta 触发 `reasoningDoneMs`；校验后 progress 携带 `validation` 且字段与预算一致；`history` 跨 attempt 不可变累积；`preparedImages` 在 preparing 阶段结构化上报。
5. **必改 `scripts/script-v3-ui-contract.test.mjs`**——该文件按正则读 `components/ScriptPanel.tsx` **源码**做契约断言，删进度条会让它直接变红，且不止一条：
   - `:58` `role="progressbar"`、`:59` `aria-valuenow={generationProgress.percent}` —— **必挂**，随进度条一并移除；
   - 但要**把契约迁移到新形态，而不是取消契约**：替换为对阶段指示的断言（`role="status"` + `aria-live="polite"` + 阶段文案可读），否则这次改动等于悄悄降低了无障碍要求；
   - `:61` `handleCancelGeneration` 预计仍能命中（取消处理器以 prop 形式留在 ScriptPanel：`onCancel={handleCancelGeneration}`），但 `:62` 的字面量 `取消生成` 会随按钮搬进 `components/script-generation-live-view.tsx`——测试头部需新增一个 `liveView` 文件句柄，把按钮相关断言的读取目标改到新组件；
   - 新增断言：思考块、已用时长、图片计数三块存在；`assert.doesNotMatch(panel, /role="progressbar"/)` 防止百分比日后被回填。
6. **扩展 `scripts/script-generation-manager.test.ts`**：progress 扩展字段随快照返回；`startedAt` 在 running 快照中可用。
7. **新增 `scripts/script-stream-preview.test.ts`**：增量解析器在 JSON 任意截断点不抛异常；title/coverTitle/segments 提取与 done 标记正确；unicode 转义与半截转义安全。
8. **新增 `scripts/db-migrations.test.ts` 用例**：`script_drafts.generationDurationMs` 追加迁移可重复执行、不破坏既有行。
9. 回归：`node scripts/script-generation-route.test.ts`、`node scripts/script-route-v3.test.ts`、`npm run lint`。

### 5.7 验收标准

1. **全程无空窗**：用推理模型（如 `qwen3.6-max-preview`）生成脚本，从点击到出稿的**任意一秒**截屏，画面上都有正在变化的真实内容——图片计数、推理滚动、正文流、或校验卡之一。
2. **时间感**：已用时长全程可见并每秒递增；无任何百分比出现。
3. 用非推理模型（如 `gemini-3.6-flash`）生成时不显示思考块，正文 3-4 秒内开始流，无报错。
4. **两种 apiStyle 实测通过，第三种显式挂起**：
   - `openai-compatible` —— qwen（有推理流）+ gemini（无推理流）双形态实测；
   - `anthropic-messages` —— kimi-k3 实测；
   - `openai-responses` —— `gpt-5.5` 实测：**正文流已验**（`response.output_text.delta`，44 事件序列完整），**推理流未验**（该模型不产出 reasoning，带 `reasoning: {summary:'auto'}` 也无任何 reasoning 事件）。
     推理字段名按官方 schema 实现 + 单测覆盖即可合入，但**必须在 §5.8 留明这半条未验**，等遇到会吐 reasoning summary 的模型时补验。不允许把它整条算作「已完成」。
5. 每次校验未通过都有可见原因卡片；最终通过有绿色确认卡并附卖点承接摘要。
6. 生成中随时可取消且立即生效（推理阶段中途取消也要立刻停）。
7. **公司网关补验（2026-08-26 已在内网执行，结论回填）**：`GPT-5-6-Luna-Standard` 经本机 LiteLLM（`openai-compatible`）流式实测——
   - ✅ `temperature=1` 直接被接受、无 400 往返；对照组 `temperature=0.5` 如期被上游 400 拒绝（红线仍然真实存在）。
   - ❌ **拿不到 `reasoning_content`**：LiteLLM 代理与绕过代理直连网关两条路径都没有任何推理 delta（delta 字段只有 `role` / `content`）。推理发生在上游服务端、首字节**之前**：复杂 prompt 响应头要等 34–43s 才返回，随后正文 5s 左右流完。usage 带 `usage_source: "anthropic"` 与 `claude_cache_creation_*` 字段——上游是 Anthropic 系模型套的 OpenAI 兼容壳；`completion_tokens`（4364）远大于可见正文（约 1415 字），推理 token 计了费但不透传。**对 UI 的含义：公司供应商用户的思考块永远不会渲染，且推理段（可 30s+）内连正文预览都是空的——§5.5 的降级路径就是公司用户的常态，计时器是他们唯一的 P0 信号。**
   - ✅ 取消即时生效：首字节前沉默期 abort 后 18ms 断开；正文流中段 abort 后 1ms 断开。
   探针脚本 `outputs/probe-2026-08-26-luna-*.mjs`（gitignored，不进代码库）。
7. 刷新页面后过程内容不丢失、不闪烁重来、不从头重播打字机。
8. 上述测试全部通过，`npm run lint` 无新增告警。

### 5.8 风险与备注

- **快照体积**：这是本方案最需要盯的量。推理全文在真实场景可达数万字，所以 `reasoningTail` 必须截断（§5.2.2）。400ms × 尾部 1.5KB + 正文数 KB 是可接受的；**若实现时图省事直接塞全文，会把轮询响应推到几十 KB／次**。
- **`percent` 字段去留**：后端继续发（API 无破坏），UI 不再渲染；标注为后续可清理项，不在本次删除以免连带改动 manager 与既有测试断言。
- **推理内容的性质（已定）**：实测 `qwen3.6-max-preview` 的推理是**英文为主、中英混杂**的（首个 chunk 就是 `"Here"` → `"'s a thinking process"`），内容包含被否决的方案、自我纠正和口头禅。
  **决定：原样展示，不翻译、不过滤、不提取中文行。** 理由：遮起来就退回半个黑箱；折叠默认收起已经足够降噪。UI 全中文而思考块是英文，这个不一致是可接受的——它本来就是「机器在想」的区域，不是给用户读的产品文案。
- **供应商可达性实测结论（2026-08-25，多轮换端点后的最终状态）**：
  | 供应商 | 协议 | 状态 | 备注 |
  | --- | --- | --- | --- |
  | `qwen` (`qwen3.6-max-preview`) | openai-compatible | ✅ 可用 | 推理流 5983 字，96% 等待在推理段 |
  | `gemini` (`gemini-3.6-flash`) | openai-compatible | ✅ 可用 | 无推理段，3.4s 首字 |
  | `kimi` (`kimi-k3` @ cf.api.fan) | anthropic-messages | ✅ 可用 | thinking 流 1139 字，83% 等待在思考段 |
  | `gpt` (`gpt-5.5` @ cf.api.fan) | openai-responses | ✅ 可用 | 正文流正常；**不产出 reasoning** |
  三种 apiStyle 全部有可达供应商，§5.7.4 的实测验收可以完整执行。
- **`openai-responses` 的推理字段仍未验**：`gpt-5.5` 走该协议时事件序列完整（`response.created` → `in_progress` → `output_item.added` → `content_part.added` → `output_text.delta ×34` → `output_text.done` → `content_part.done` → `output_item.done` → `completed`），但即使请求带 `reasoning: { summary: 'auto' }` 也**不返回任何 reasoning 事件**。
  因此 `response.reasoning_summary_text.delta` 这个字段名只能按官方 schema 实现。风险已被隔离：三种协议共用 §5.1 的 reader 与回调契约，该字段名若有偏差只影响这一路的推理预览（退化为「无推理流」，正是 §5.5 已定义的降级路径），不波及正文流与另外两种协议。
- **`gpt-5.6-luna` 不可用（模型级门禁，非网关级）**：同一个 `cf.api.fan` 上 `gpt-5.5` 一切正常，但 `gpt-5.6-luna` 的 `/v1/responses` 返回 **HTTP 403**「请使用标准 Codex 客户端请求，请避免任何基于我方 API 二次分发的 API 转接接入」，`/v1/chat/completions` 返回 **HTTP 400 `protocol_not_supported`**。
  该模型对通用 API 客户端做客户端指纹校验。**不采取伪造客户端标识的做法**——那是绕过供应商明确设置的访问控制。要用这个模型只能换允许通用客户端的网关。
- **公司网关 `GPT-5-6-Luna-Standard` 推理不透传（2026-08-26 实测，详见 §5.7 第 7 条）**：「思考块覆盖 96% 等待」的 P0 论证只对 qwen / kimi 成立；公司供应商用户在整个推理段只有计时器与阶段行兜底。设计无需改动（降级路径已定义），但做排期与验收预期时，不要把思考块算作公司用户可得的改善。
- **`cf.api.fan` 的 gpt-5.5 路由到 Azure**：响应体带 `prompt_filter_results` / `content_filter_results`。内容过滤字段不影响 delta 解析，但适配层解析时**不要假设 `choices[0]` 一定存在**——实测首个 chunk 的 `choices` 是空数组。
- **演示页** `outputs/script-stream-demo.html` 留在 outputs（gitignored），不进代码库。

## 6. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `lib/script-providers/sse.ts` | **新增**：共享 SSE reader（从 `openai-responses.ts:42-105` 抽出） |
| `lib/script-providers/openai-responses.ts` | 改用共享 reader；接入正文/推理双回调（`reasoning: {summary:'auto'}`） |
| `lib/script-providers/openai-compatible.ts` | 新增 SSE 流式路径（`content` / `reasoning_content` 分流） |
| `lib/script-providers/anthropic-messages.ts` | 新增 SSE 流式路径（`text_delta` / `thinking_delta` 分流） |
| `lib/script-providers/index.ts` | `completeJson` 按 apiStyle 分发流式回调 |
| `lib/script-generation-v3.ts` | 进度类型扩展 + 生成循环发流式/推理/校验 progress |
| `lib/script-generation-v3-service.ts` | 图片准备段补 `preparedImages` 结构化计数 |
| `lib/script-stream-preview.ts` | **新增**：增量 JSON 流解析纯函数（从 demo 移植） |
| `lib/db-migrations.ts` | 追加 `script_drafts.generationDurationMs`（P1） |
| `components/script-generation-live-view.tsx` | **新增**：状态条 + 阶段行 + 思考块 + 校验卡 + 正文预览 + 打字机缓冲 |
| `components/ScriptPanel.tsx` | 删进度条，接入 LiveView；轮询 400ms |
| `scripts/script-provider-sse.test.ts` | 新增 |
| `scripts/script-provider-stream-adapters.test.ts` | 新增 |
| `scripts/script-stream-preview.test.ts` | 新增 |
| `scripts/script-generation-v3.test.ts` | 扩展 |
| `scripts/script-generation-manager.test.ts` | 扩展 |
| `scripts/script-v3-ui-contract.test.mjs` | **改**：契约迁移到新形态（含无障碍语义）+ 新增组件句柄 |
| `scripts/db-migrations.test.ts` | 扩展 |
| `scripts/openai-responses-adapter.test.ts` | 回归护栏，不改断言 |
| `docs/reference/供应商与队列.md` | 补一节：脚本供应商流式约定（三种 apiStyle 的 delta schema 对照表） |

零改动：`script-generation-manager.ts`、script-generation 路由。
其中 `script-generation-manager.ts` 的零改动**以 §5.3 的 history 不可变约束为前提**——若实现时改成在 manager 内深拷贝，本行作废。

## 7. 实施顺序建议

按「最早拿到用户可感知的改善」排：

1. **已用时长计时器**（纯前端，`startedAt` 现成）—— 半小时的活，立刻消除「是不是卡死了」。
2. **共享 SSE 模块 + `openai-responses` 迁移** —— 有既有测试当安全网，先把地基铺稳。
3. **`openai-compatible` 推理流 + 思考块 UI** —— 覆盖 96% 等待时间，本 PRD 的核心价值（仅对推理透传供应商成立；公司供应商无此收益，见 §5.7 第 7 条）。
4. **校验反馈卡 + 图片计数** —— 补齐剩余阶段。
5. **流式正文预览 + 打字机缓冲** —— 最后 1% 的锦上添花。
6. **`anthropic-messages` 流式 + 耗时落库** —— 收尾覆盖。

每步独立可交付、可回滚。
