# 脚本生成过程透明化（执行文档）

> 本文是 2026-08-26 确认的执行计划，先写文档后执行；执行中如有实现偏差，回头同步本文。
> **设计权威是 PRD**：`docs/2026-08-25-script-generation-streaming-prd.md`（2026-08-26 三轮修订版）。
> 设计取舍（为什么轮询不另开 SSE 端点、为什么 `reasoningTail` 只留尾部、为什么 manager 零改动）
> 一律以 PRD 为准，本文只规定「怎么落地、怎么验证」，不重新论证。

---

## 一、执行前必须知道的实测结论（摘自 PRD，决定验收口径）

1. **推理模型 83–96% 的等待在推理段**（qwen 96% / kimi 83%，已实测）；推理流在
   `openai-compatible`（`reasoning_content`）与 `anthropic-messages`（`thinking_delta`）上均已验证可拿。
2. **公司 `GPT-5-6-Luna-Standard` 推理不透传**（2026-08-26 实测，PRD §5.7 第 7 条）：
   经 LiteLLM 代理与直连网关两条路径都无推理 delta；复杂 prompt 首字节前沉默 34–43s，期间正文亦为空。
   **思考块对公司用户永不渲染，计时器是他们推理段唯一的信号——这是正常口径，不是缺陷。**
3. `temperature=1` 红线实测仍真实：公司 Luna 传 0.5 被上游 400 拒绝；取消在沉默期 18ms、
   正文流中段 1ms 生效。
4. 非推理模型（Gemini 3.4s / gpt-5.5 4.3s 首字）无推理段，思考块自动不渲染。
5. `openai-responses` 的推理字段名（`response.reasoning_summary_text.delta`）**未验**——
   `gpt-5.5` 不产出 reasoning。按官方 schema 实现 + 单测覆盖即可合入，但文档与验收里**不许标已验证**。

---

## 二、范围与红线

### 本轮做

按 PRD §7 的六步（见 §三），每步独立可交付、可回滚。

### 本轮不做

- 不改生成逻辑：prompt、校验规则、修正循环、落库格式一律不动（PRD §2 非目标）。
- 不做「预计剩余时间」（会重新引入虚假精度）。
- 不删后端 `percent` 字段（UI 不再渲染即可，标注为后续可清理项）。
- 不改其他步骤面板；不动 `script-generation-manager.ts` 与 script-generation 路由。

### 红线（逐条对应 PRD，违反即返工）

- **`temperature=1` 三层保障原样穿过流式改造**：重试体必须是 `{ ...body, temperature: 1 }` 的展开式
  （`lib/script-providers/openai-compatible.ts:154`），**不许重构成重新构造 body**——那会把
  `stream: true` / `stream_options` 弄丢，且只在公司模型上复现。`isDefaultTemperatureOnlyModel()`
  前缀命中时首请求就带 1，不产生 400 往返。
- **数据库迁移只追加**：`script_drafts.generationDurationMs` 追加在 `CORE_DB_MIGRATIONS` 末尾，
  不改已有条目。
- **`lib/script-generation-manager.ts` 零改动的前提**是 v3 层**不可变重建** `history`
  （`history: [...prevHistory, next]`，禁止对上一快照里的数组 `push`）——manager 的
  `{ ...progress }` 浅拷贝（`:123` / `:248`）会让数组共享引用。若实现时改成 manager 内深拷贝，
  必须回头改本文与 PRD §6 的「零改动」行。
- **完整 CoT 不进快照、不落库**：`reasoningTail` 只留尾部 ~1500 字，`reasoningChars` 记全量。
  图省事塞全文会把 400ms 轮询响应推到几十 KB/次。
- **无障碍语义不随进度条一起丢**：外层 `aria-live="polite"`（`ScriptPanel.tsx:880`）保留，
  阶段指示行补 `role="status"`；思考块滚动文本 `aria-hidden`。
- UI 颜色一律走设计令牌（`bg-surface-subtle` / `border-hairline` / `text-ink*` / `bg-accent`），
  不新增硬编码色值。
- 日志不打印请求头、密钥、完整鉴权串；`streamedContent` / `reasoningTail` 只进内存快照，
  不落库、不参与解析链路。

---

## 三、实施步骤

锚点行号均已按 2026-08-26 工作树核验。每步给出：改动 → 要点 → 测试 → 完成判定。

### 步骤 1：已用时长计时器 + 状态条（纯前端，半小时）

- 改动：`components/ScriptPanel.tsx`（`:878-912` 进度条区块上方/替换其头部行）。
- 要点：`startedAt` 已在快照内（`script-generation-manager.ts:127`），
  时长 = `Date.now() - Date.parse(snapshot.startedAt)`，每秒跳一次，纯前端。
  超过 30 秒仍无流式信号追加「推理模型在正文返回前可能有数十秒沉默，属正常现象」；
  超过 90 秒追加「推理模型通常需要 1-2 分钟」（PRD §5.4.1）。
- 测试：`npm run lint`；手动点开生成看秒数跳动。
- 判定：生成中任意时刻可见已用秒数；无百分比新增。

### 步骤 2：共享 SSE 模块 + `openai-responses` 迁移（地基，先铺）

- 改动：新建 `lib/script-providers/sse.ts`（把 `openai-responses.ts:42-105` 的
  `consumeSseLine` / `readWithAbort` / `readSseText` 读取循环抽出为
  `readSseStream(body, signal, { onLine })`）；`openai-responses.ts` 改为调用共享模块，
  行为不变。
- **实现偏差（2026-08-26 回填）**：为接入推理摘要，`openai-responses` 请求体新增了
  `reasoning: { summary: 'auto' }`（推理流的 opt-in 开关），读取与错误语义保持原样；
  该推理字段 `response.reasoning_summary_text.delta` 按官方 schema 实现 + 单测覆盖，未实测。
- 要点：**先跑通既有测试再动手**——`node scripts/openai-responses-adapter.test.ts` 是重构安全网；
  半截 JSON 行忽略、`[DONE]`、注释行、跨 chunk 断行、abort 中断语义全部保持。
- 测试：新增 `scripts/script-provider-sse.test.ts`（行缓冲 / `[DONE]` / 注释 / 断行 / abort /
  异常提前结束）；回归 `openai-responses-adapter.test.ts`，断言一个字不改。
- 判定：两个测试文件全绿。

### 步骤 3：`openai-compatible` 流式 + 思考块 UI（核心价值步骤）

- 改动：
  - `lib/script-providers/openai-compatible.ts`：新增 SSE 流式路径
    （`choices[0].delta.content` / `reasoning_content` 分流）；加
    `stream_options: { include_usage: true }`；usage 缺失走现有容错。
  - `lib/script-providers/index.ts:110` `completeJson` 增加可选 `onTextDelta` / `onReasoningDelta`，
    按 `runtime.apiStyle` 分发。
  - `lib/script-generation-v3.ts`：`CompleteJsonRequest`（`:26-34`）与
    `ScriptGenerationProgress`（`:36-41`）扩展（PRD §5.2.2 的字段定义原样照抄）；
    生成循环（`:1137-1144`）每次 attempt 开始清空流式字段；回调转发累积全文；
    首个正文 delta 记 `reasoningDoneMs`。
  - 新建 `components/script-generation-live-view.tsx`：状态条 + 阶段行 + 思考块
    （本步骤先落地这三块）；`components/ScriptPanel.tsx` 删进度条接入 LiveView，
    轮询 1000ms → 400ms（`:421` 与 `:428` 两处）。
- 要点：回调契约是**累积全文**不是增量；拿不到推理流时 `onReasoningDelta` 从不触发即可，
  UI 不渲染思考块，**不报错、不特判**。
- 测试：新增 `scripts/script-provider-stream-adapters.test.ts` 的 openai-compatible 部分——
  重点三条：**temperature 400 重试后请求体仍带 `stream: true` / `stream_options` 且 `temperature` 为 1**
  （公司模型唯一自动化防线）；`isDefaultTemperatureOnlyModel()` 命中首请求即带 1 且无 400 往返；
  只有正文时 `onReasoningDelta` 从不触发。
  扩展 `scripts/script-generation-v3.test.ts`：流式字段随 progress 上报、`reasoningTail` 截断、
  `reasoningDoneMs` 记录；注意 `:244-249` 的进度事件序列 deepEqual 断言**不许改**（校验卡挂字段
  不新增事件，见步骤 4）。
  **必改** `scripts/script-v3-ui-contract.test.mjs`：`:58-59` 的 `role="progressbar"` /
  `aria-valuenow` 断言随进度条移除，替换为 `role="status"` + `aria-live="polite"` 契约；
  `:61` 的 `取消生成` 字面量迁到新组件文件（测试头部新增 liveView 文件句柄）；
  新增 `assert.doesNotMatch(panel, /role="progressbar"/)` 防回填。
  注意该测试文件是**混合行尾**，编辑时保持既有风格。
- 判定：qwen（有推理流）实测思考块滚动、正文流出；gemini（无推理流）不渲染思考块且无报错。

### 步骤 4：校验反馈卡 + 图片计数

- 改动：
  - `lib/script-generation-v3.ts`：`normalizeCandidate` 之后（`:1171-1185`）把 `validation`
    挂到**现有** `validating` progress 事件（`:1165-1170`），不新增事件；
    `history` 不可变追加；素材失配路径同样先发 validation 再抛错；
    最终通过的 validation 附 `sellingPointUsage` 三态摘要。
  - `lib/script-generation-v3-service.ts`：图片准备回调（`:202-207`）在写 message 之外
    **同时**写 `preparedImages: [completed, total]` 结构化字段。
  - LiveView：校验卡列表 + 阶段行图片 `N/M` 确定态计数。
- 要点：数据全部现成（`normalized.qualification` / `contentCharacterCount` /
  `estimatedNarrationDurationSec` / budget 区间 / `advisories` 截前 3 条）。
- 测试：扩展 `script-generation-v3.test.ts`（validation 字段与预算一致、history 跨 attempt
  不可变累积、preparedImages 结构化上报）；扩展 `script-generation-manager.test.ts`
  （扩展字段随快照返回、`startedAt` 可用）。
- 判定：人为构造一次超长口播 → 看到橙色未通过卡（含预计秒数与目标区间）→ 修正后绿色通过卡。

### 步骤 5：流式正文预览 + 打字机缓冲（P1，锦上添花，不过度设计）

- 改动：新建 `lib/script-stream-preview.ts`（增量 JSON 解析纯函数，从
  `outputs/script-stream-demo.html` 移植，任意截断点不抛异常）；LiveView 加正文预览块与
  打字机缓冲（正文与推理流共用同一缓冲实现，纯前端）。
- 要点：刷新/步骤切换后的快照恢复走现有逻辑（`ScriptPanel.tsx:456-464` 不动）；
  打字机缓冲须识别「快照跳变」直接吐完，不从头重播。
- 测试：新增 `scripts/script-stream-preview.test.ts`（任意截断点、unicode 半截转义安全）。
- 判定：正文段可见逐字段生长（标题 → 封面标题 → 各段 narration/subtitle），写入中字段带光标。

### 步骤 6：`anthropic-messages` 流式 + 耗时落库（收尾）

- 改动：`lib/script-providers/anthropic-messages.ts` 新增 SSE 流式路径
  （`content_block_delta` → `text_delta` / `thinking_delta` 分流；需
  `stream: true` + `thinking: { type: 'enabled', budget_tokens }`）；
  `lib/db-migrations.ts` 末尾追加 `script_drafts.generationDurationMs INTEGER`，
  成功落库时写入；UI 状态条追加「上次约 1 分 12 秒」（是参照不是预测）。
- 测试：`script-provider-stream-adapters.test.ts` 补 anthropic 部分；
  `scripts/db-migrations.test.ts` 补追加迁移可重复执行用例。
- 判定：kimi-k3 实测思考块滚动；重新生成后状态条显示上次耗时。

### 收尾（所有步骤完成后）

- `docs/reference/供应商与队列.md` 补一节：脚本供应商流式约定（三种 apiStyle delta schema
  对照表 + 公司 Luna 推理不透传实测结论）。
- 回归：`node scripts/script-generation-route.test.ts`、`node scripts/script-route-v3.test.ts`、
  `npm run lint`。

---

## 四、测试清单与必跑命令

```bash
node scripts/openai-responses-adapter.test.ts        # 步骤 2 重构安全网（先跑）
node scripts/script-provider-sse.test.ts             # 新增
node scripts/script-provider-stream-adapters.test.ts # 新增（temperature 红线自动化防线）
node scripts/script-generation-v3.test.ts            # 扩展（进度序列断言不许改）
node scripts/script-generation-manager.test.ts       # 扩展
node scripts/script-v3-ui-contract.test.mjs          # 必改（契约迁移，不是取消契约）
node scripts/script-stream-preview.test.ts           # 新增
node scripts/db-migrations.test.ts                   # 扩展
node scripts/script-generation-route.test.ts         # 回归
node scripts/script-route-v3.test.ts                 # 回归
npm run lint
```

---

## 五、人工验收（分供应商矩阵）

| 供应商 | 协议 | 预期画面 | 口径 |
| --- | --- | --- | --- |
| `qwen` (`qwen3.6-max-preview`) | openai-compatible | 思考块滚动（英文为主属正常，PRD §5.8 已定原样展示）→ 正文流 → 校验卡 | 思考块可见为核心验收点 |
| `gemini` (`gemini-3.6-flash`) | openai-compatible | 无思考块，3–4s 进正文 | 不渲染思考块且无报错即过 |
| `kimi` (`kimi-k3`) | anthropic-messages | 思考块滚动 → 正文流 | 步骤 6 后验 |
| `gpt` (`gpt-5.5`) | openai-responses | 无思考块，正文流 | 推理流未验属已知挂起项，不算缺陷 |
| 公司 `GPT-5-6-Luna-Standard`（需内网） | openai-compatible | **无思考块**；推理段 30s+ 只有计时器与阶段行；正文流出 | 推理段只有计时器是**正常口径**（上游不透传），必须确认无 400、取消即时生效 |

通用验收（每个供应商都过一遍）：

1. 从点击到出稿任意一秒截屏，画面都有真实内容在动（计数 / 思考流 / 正文流 / 校验卡之一），
   公司供应商在推理段的例外是计时器 + 阶段行。
2. 已用时长全程可见、每秒递增；无任何百分比出现。
3. 生成中点取消立即停（沉默期与正文流中段各试一次）。
4. 刷新页面后过程内容不丢、不闪烁、打字机不从开头重播。
5. 校验未通过有橙色原因卡；最终通过有绿色确认卡并附卖点承接摘要。

---

## 六、验收口径

- **全程无空窗**：除「公司供应商推理段」这一已实测确认的例外（计时器兜底）外，任意时刻有真实内容。
- **时间感**：已用时长全程可见；`role="progressbar"` 不复存在，UI 契约测试防回填。
- **三种 apiStyle**：正文流全部实测通过；推理流 qwen / kimi 实测通过，`openai-responses`
  推理字段按 schema 实现 + 单测覆盖、文档显式标注未验。
- **公司红线**：`temperature=1` 无 400 往返有自动化断言守着（步骤 3 测试）。
- **零改动清单**：`script-generation-manager.ts`、script-generation 路由、生成逻辑
  （prompt / 校验规则 / 修正循环 / 落库格式）diff 必须为空。
- 上述测试全部通过，`npm run lint` 无新增告警。
