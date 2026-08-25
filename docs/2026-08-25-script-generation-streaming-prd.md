# PRD：脚本生成过程透明化（阶段指示 + 校验反馈 + 流式正文）

日期：2026-08-25
状态：待评审
演示原型：`outputs/script-stream-demo.html`（已通过交互验证方向可行）

---

## 1. 背景与问题

脚本生成面板（`components/ScriptPanel.tsx:879-912`）目前展示一个 0-100% 进度条。实现上它**不是假插值**，而是阶段锚点（`lib/script-generation-v3-service.ts:194-293`、`lib/script-generation-v3.ts:1137-1170`）：

- 5% → 27%：分镜图准备（真实进度，按张数）
- 32% / 45%：第 1 次生成中 / 校验中
- 52% / 65% / 72% / 85%：第 2、3 次尝试（修正）
- 92% 保存 → 100% 完成

问题：LLM 调用占全程 90% 以上时间，而这期间百分比冻住不动。用户体验上等同于假进度条，还暗示了不存在的精确度。同时：

- 校验未通过的**原因**（口播偏长/偏短、结构问题）在后端已算出（`qualification`、`advisories`、`contentCharacterCount`），却只用于构造修正 prompt，从不告诉用户；
- 模型「看图判断卖点能否被画面承接」的产出（`sellingPointUsage`）同样不可见；
- 项目自己已在批量生产模块立过规矩——`lib/batch-production/executors.ts:37`：「不可测的阶段 percent 必须为 null，不允许伪造」。脚本生成违反了同一原则。

## 2. 目标

1. 删除百分比进度条，替换为**不定态阶段指示**（只有真实状态迁移，无虚假精度）。
2. **校验反馈透明化**：每次校验后告知用户结果与未通过原因（预计口播时长/字数 vs 目标区间）。
3. **流式正文预览**：脚本 JSON 边生成边解析边渲染（标题 → 封面标题 → 各段口播/字幕），用户看得到「在写什么」，方向不对可立即取消（取消链路已存在，复用）。
4. 不展示原始思维链；若网关返回 `reasoning_content`，收进折叠区（P2，可选）。

非目标：

- 不改生成逻辑本身（prompt、校验规则、修正循环、落库格式一律不动）；
- 不改其他步骤面板；
- 不为 `native-gemini` / `anthropic-messages` / `openai-responses` 适配层补流式（见 §5.1 降级策略）。

## 3. 用户故事

- 作为用户，点击「生成脚本」后，我能看到当前处于「准备图片 / 生成中（第 N 次尝试）/ 校验中 / 修正中」哪个阶段，而不是一个会骗人的百分比。
- 作为用户，生成过程中我能逐段看到口播正文被写出来，发现方向错误时立刻取消，不用等 1-2 分钟跑完。
- 作为用户，每次校验未通过时我能看到「为什么」（如：预计口播 49s，目标 20s，上限 22s），并知道系统正在针对这个问题修正。

## 4. 方案总览

**推荐方案：复用现有轮询通道，在进度快照中携带累积正文。**

数据通路：

```text
供应商 SSE 流
  → openai-compatible 适配层（解析 delta，回调累积全文）
  → generateScriptV3 的 onProgress（progress 携带 streamedContent + validation）
  → script-generation-manager（快照整体替换，无结构改动）
  → GET /api/projects/[id]/script-generation（现有 1s 轮询，改为 400ms）
  → ScriptPanel（阶段 pill + 校验反馈卡 + 增量 JSON 解析预览）
```

**被否决的替代方案：浏览器 SSE 直连新增流式端点。** 理由：① 需要在 manager 注册表之外再开一条推送通道，刷新/步骤切换后的状态恢复逻辑要重写一遍；② 轮询快照天然携带全量累积文本，刷新后无缝恢复；③ 本地单用户应用，400ms 轮询的流畅度足够，没有服务器推送的规模理由。

## 5. 详细设计

### 5.1 适配层：`lib/script-providers/openai-compatible.ts`

新增流式能力，**不改动现有非流式路径的行为**：

1. `ChatOptions` 增加可选回调：
   - `onTextDelta?(accumulated: string): void` — 每次收到正文 delta 时回调**累积全文**（不是增量，消费者无需自己拼接）；
   - `onReasoningDelta?(accumulated: string): void` —（P2）捕获 `delta.reasoning_content`，公司网关推理模型可能返回。
2. `chatCompletion` 内部：当存在 `onTextDelta` 时，请求体加 `stream: true` 与 `stream_options: { include_usage: true }`，响应按 SSE 行解析：
   - 逐行 `data:` → JSON → `choices[0].delta.content` 累积并回调；`[DONE]` 结束；
   - 最终 usage 从 `include_usage` 的末块取得；缺失时 `usage: undefined` 走现有记账容错；
   - `finishLlmUsageCall` 的 `rawOutput` 用累积全文，与非流式一致。
3. **temperature=1 重试逻辑保持不变**：400 特征判断（`openai-compatible.ts:146-165`）发生在读取响应体之前，流式与非流式完全同构。命中重试时清空已累积文本重新计。
4. 取消：fetch 已接 `requestControl.signal`（`openai-compatible.ts:116-121`），reader 循环内每次迭代检查 `signal.aborted` 并抛 AbortError，保证「取消生成」即时生效。
5. 解析容错：半截 JSON 行忽略；流非正常结束（无 `[DONE]`）且已收到内容则按现有「返回了无效 JSON」语义抛错，进入修正循环。

注册入口 `lib/script-providers/index.ts:110` `completeJson`：

- 入参增加可选 `onTextDelta` / `onReasoningDelta`；
- 仅当 `runtime.apiStyle === 'openai-compatible'` 时向下透传；其他 apiStyle **静默忽略回调**——功能降级为「无流式预览，阶段与校验反馈照常」，不报错。
- 覆盖范围：全部内置脚本供应商（gemini/qwen/kimi/gpt，见 `lib/script-providers/config.ts:55-100`）与公司 GPT（`GPT-5-6-Luna-Standard`，`lib/seed.ts:344-379`）均为 `openai-compatible`，一次实现全覆盖。

### 5.2 领域层：`lib/script-generation-v3.ts`

1. `CompleteJsonRequest`（`:25-34`）增加 `onTextDelta?(accumulated: string): void`。
2. `ScriptGenerationProgress`（`:36-41`）扩展：

   ```ts
   export interface ScriptGenerationValidationFeedback {
     attempt: number;
     qualification: 'qualified' | 'too_short' | 'too_long' | 'contract_invalid';
     contentCharacterCount: number;
     estimatedNarrationDurationSec: number;
     targetCharacterRange: [number, number];
     advisories: string[]; // 截断至前 3 条
   }
   export interface ScriptGenerationProgress {
     phase: 'preparing' | 'generating' | 'validating' | 'saving' | 'completed';
     percent: number;              // 保留字段，UI 不再展示（避免连带改动 manager/tests）
     message: string;
     attempt?: number;
     streamedContent?: string;     // 当前 attempt 的累积正文（半截 JSON，仅供展示）
     validation?: ScriptGenerationValidationFeedback; // 最近一次校验结果
     history?: ScriptGenerationValidationFeedback[];  // 历次校验记录（驱动反馈卡列表）
   }
   ```

3. `generateScriptV3`（`:1120`）生成循环改动：
   - 每次 attempt 开始：发 progress（`phase: 'generating'`，`streamedContent: ''` 清空上一轮的流）；
   - 调 `dependencies.completeJson` 时传入 `onTextDelta`，把累积文本直接转发给 `onProgress`——manager 本来就是整体替换 `{...progress}`（`script-generation-manager.ts:246-249`），写快照代价为零，无需节流；
   - `normalizeCandidate` 之后（`:1171-1185`），无论通过与否，发一条带 `validation` 的 progress：数据全部现成（`normalized.qualification`、`script.contentCharacterCount`、`script.estimatedNarrationDurationSec`、`budget` 区间、`advisories`），`history` 追加保留；
   - 素材失配（`ScriptMaterialMismatchError`）路径同样先发 validation 再抛错，用户能看到「哪些叙事节拍画面承接不了」（该信息已在 error details 白名单内，`script-generation-manager.ts:12-20`）。
4. 卖点承接判断（`sellingPointUsage`）随最终校验通过的 validation 一并可在 UI 展示：used / omitted / omitted_no_visual_support 三态——这正是「模型纠结哪些点能用」的产出，在结果页已有数据，本次只在生成完成后的校验卡中附摘要（不新开面板）。

### 5.3 任务管理与路由

- `lib/script-generation-manager.ts`：**零改动**。progress 整体替换语义自动携带新字段；终态快照保留 10 分钟不变。
- `app/api/projects/[id]/script-generation/route.ts` 与 `lib/script-generation-route-handler.ts`：**零改动**。GET 快照原样序列化。
- 注意点：`streamedContent` 是半截 JSON 字符串，**只进内存快照供前端展示，不落库、不参与解析链路**；终态（succeeded/failed/cancelled）时由 manager 现有语义随 progress 保留展示（成功页会被草稿数据替换，无需清理）。

### 5.4 UI：`components/ScriptPanel.tsx`

替换 `:878-912` 的进度条区块为新组件 `ScriptGenerationLiveView`（新建 `components/script-generation-live-view.tsx`，保持 ScriptPanel 体积可控）：

1. **阶段指示行**：pill 序列「准备图片 → 生成中（第 N 次尝试）→ 校验中 →（修正中）」，当前阶段脉冲动画点；文案沿用 `progress.message`。颜色一律走设计令牌（`bg-surface-subtle` / `border-hairline` / `text-ink*` / `bg-accent`），暗色主题自动生效，不新增硬编码色值（AGENTS.md 外观约定）。
2. **校验反馈卡列表**：渲染 `progress.history` + 当前 `validation`：
   - 未通过（橙）：「第 1 次校验未通过：口播偏长（预计 49.1s，目标 20s，上限 22.0s）→ 已发起修正」；
   - 通过（绿）：「校验通过：预计口播 15.8s / 目标 20s」；
   - `contract_invalid` 显示「返回格式异常，正在要求模型重新输出」；
   - 附带 `sellingPointUsage` 摘要（最终通过时）：「卖点承接：3 用 / 1 画面不足略过」。
3. **流式预览**：增量解析 `streamedContent`，渲染标题 → 封面标题（主｜副）→ 各段「序号 + narration + subtitle」，正在写入的字段带闪烁光标 `▍`。解析器从演示页已验证的实现移植为纯函数模块 `lib/script-stream-preview.ts`（任意截断点不抛异常，已在 demo 验证）。
4. **降级**：`streamedContent` 始终为空（非 openai-compatible 供应商）时预览区整体不渲染，只显示阶段行与校验卡。
5. **轮询间隔**：running 期间 1000ms → 400ms（`ScriptPanel.tsx:421`），取消/失败/成功路径不变。
6. **思考过程折叠区（P2）**：`reasoningContent` 非空时显示 `<details>` 折叠区，默认收起。
7. 删除：`role="progressbar"` 区块与 `generationProgress.percent` 渲染；`INITIAL_GENERATION_PROGRESS` 类型同步。

### 5.5 边界情况

| 场景 | 行为 |
| --- | --- |
| 刷新页面 / 切换步骤后回来 | 轮询恢复快照，`streamedContent` 全量重渲染，预览无缝续上（现有恢复逻辑 `ScriptPanel.tsx:456-464` 不动） |
| 生成中点取消 | 适配层 reader 立即中断 → AbortError 沿现有链路上抛 → cancelled 静默恢复（现有语义不变） |
| 修正循环开始新 attempt | `streamedContent` 清空重流，上一轮的校验卡保留在反馈列表里 |
| 网关不支持 `stream_options` | usage 缺失走现有容错；正文 delta 不受影响 |
| 网关不支持 stream 直接报错 | 走现有错误处理（HTTP 错误 → 抛错 → 失败面板），不自动降级重试非流式（保持行为可预期；真实网关已确认支持 SSE） |
| 流式中途 JSON 截断（网络断开） | 按「返回了无效 JSON」语义进修正循环，与现有解析级失败同路径（`script-generation-v3.ts:1156-1163`） |
| 停机（shutdown） | manager 的 AbortController 广播现有逻辑不变；流式 reader 同样被 abort |

### 5.6 测试计划

改动模块对应测试（AGENTS.md：改哪个模块跑同名测试）：

1. **新增 `scripts/script-provider-openai-compatible-stream.test.ts`**：
   - mock fetch 返回 SSE ReadableStream → 断言 `onTextDelta` 逐次回调累积全文、返回值等于拼接全文、usage 记账被调用；
   - temperature 400 特征 → 重试后正常流式，且回调文本不含第一次的内容；
   - 流中途 abort → AbortError；
   - 无 `[DONE]` 提前结束 → 抛「无效 JSON」类错误。
2. **扩展 `scripts/script-generation-v3.test.ts`**：注入带 `onTextDelta` 的 fake completeJson → 断言 generating 阶段 progress 携带 `streamedContent`；校验后 progress 携带 `validation` 且字段与预算一致；`history` 跨 attempt 累积。
3. **扩展 `scripts/script-generation-manager.test.ts`**：progress 扩展字段（streamedContent/validation/history）随快照返回。
4. **新增 `scripts/script-stream-preview.test.ts`**：增量解析器在 JSON 任意截断点不抛异常；title/coverTitle/segments 提取与 done 标记正确；unicode 转义与半截转义安全。
5. 回归：`node scripts/script-generation-route.test.ts`、`node scripts/script-route-v3.test.ts`、`npm run lint`。

### 5.7 验收标准

1. 生成全程无百分比出现；阶段指示只反映真实状态迁移。
2. 使用 GPT（公司网关）生成脚本时，正文逐段流式出现，可中途取消且立即生效。
3. 每次校验未通过都有可见原因卡片；最终通过有绿色确认卡。
4. 刷新页面后预览内容不丢失、不闪烁重来（快照全量恢复）。
5. 切换为不支持流式的供应商时，阶段与校验反馈正常，无报错。
6. 上述测试全部通过，`npm run lint` 无新增告警。

### 5.8 风险与备注

- **轮询负载**：400ms 一次 GET，快照含全文（KB 级），本机单用户无压力。
- **percent 字段去留**：后端继续发（API 无破坏），UI 不再渲染；标注为后续可清理项，不在本次删除以免连带改动 manager 与既有测试断言。
- **演示页** `outputs/script-stream-demo.html` 留在 outputs（gitignored），不进代码库。
- 思维链展示刻意收敛为 P2 折叠区：原始 CoT 对终端用户是噪音，且部分推理模型不暴露。

## 6. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `lib/script-providers/openai-compatible.ts` | 新增 SSE 流式路径（onTextDelta/onReasoningDelta） |
| `lib/script-providers/index.ts` | completeJson 透传流式回调（仅 openai-compatible） |
| `lib/script-generation-v3.ts` | 进度类型扩展 + 生成循环发流式/校验 progress |
| `lib/script-stream-preview.ts` | 新增：增量 JSON 流解析纯函数（从 demo 移植） |
| `components/script-generation-live-view.tsx` | 新增：阶段行 + 校验卡 + 流式预览组件 |
| `components/ScriptPanel.tsx` | 删进度条，接入 LiveView；轮询 400ms |
| `scripts/script-provider-openai-compatible-stream.test.ts` | 新增 |
| `scripts/script-stream-preview.test.ts` | 新增 |
| `scripts/script-generation-v3.test.ts` | 扩展 |
| `scripts/script-generation-manager.test.ts` | 扩展 |
| `docs/reference/供应商与队列.md` | 补一节：脚本供应商流式约定 |

零改动：`script-generation-manager.ts`、script-generation 路由、`script-generation-v3-service.ts`（onProgress 签名不变即可，若 TS 需要则同步类型导入）。
