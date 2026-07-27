# 智能混剪 · 对齐 AI-remix 匹配行为 修复执行文档

> 日期：2026-07-26
> 类型：交接执行文档（可由另一个 AI/工程师独立执行）
> 触发：主理人在真实项目 `ps691-b` 实测「第 3 步预览看不到任何视频素材」（视频轨全空、字幕音频正常）。追问「是不是素材分析器有问题、是不是 GPT」→ 挖出匹配失效；再追问「现在是否还是语义优先」→ 挖出语义完全没参与；最后明确要求：**「和 aimixcut 项目一样：语义优先匹配素材、拼接素材，中间的素材片段截取用它的方法」**。
> 本文档已**逐条比对 AI-remix 源码**（`/Users/liangpeijian/for-cc/AI-mixcut/AI-remix-master/short-video-mashup-tool`），列出 5 处实质差异与对齐方案。
> 结论先行：**素材分析器没有问题**（Gemini `gemini-3-flash-preview`，7/7 成功，标签描述质量良好）。

---

## 0. 一句话摘要

我们 2026-07-23 移植 AI-remix 时，**求解器本体移植得相当忠实**（最小费用流、语义地板、复用惩罚、节拍吸附几乎逐行对应），但**它上游的"喂什么进去"和下游的"兜不住怎么办"这两端没有对齐**，导致：

1. **句段被切得太长**（我们 3 段 × 7.4s；AI-remix 5–8 段 × ~2–3s）→ 长度可行性必然全灭。
2. **关键词是 bigram 碎片**（AI-remix 是 LLM 产出的画面关键词）→ 关键词通道恒为 0，还把碎片当噪声喂进了语义打分 prompt。
3. **无可行候选时留空**（AI-remix 绝不留空，忽略长度也要给一个）→ 视频轨全空。
4. **语义打分调用无重试**（AI-remix 有指数退避重试）→ 一次抖动即全局降级。
5. **降级后静默**（无日志、无 UI 提示）→ 排查困难。

**最关键的是第 1 条**：光把句段切细（对齐 AI-remix 的 5–8 段），主理人现有的 7×5.05s 素材就能正常匹配（22.32s ÷ 7 段 ≈ 3.19s/段 < 5.05s ✅）。其余 4 条是把行为真正对齐、并防止下次静默失败。

> ⚠️ **本文档 v1 曾推荐一个自创的「句段预切槽位（Slot Pre-split）」方案——已废弃。** AI-remix 根本不需要它：它是靠**上游把句段切细**解决的，求解器始终保持 1 句 = 1 场景。照抄 AI-remix 比自创机制更稳，也更符合主理人「和 aimixcut 一样」的要求。

---

## 0.1 执行顺序建议（**动手前先读这一节**）

**不要一口气把 §2 全推完再验收**——中间有两个天然的验证点，跳过它们会让后面的问题很难定位。

```
① §2.1 切句变细                        → 验证：视频轨有画面了（P0 解除，能出片）
② 切 gpt-5.4（纯改配置，零代码）        → 验证：semanticFallback=false、语义矩阵各行数值不同
③ §2.3 关键词 + §2.4 prompt/重试        → 把降级路径与 prompt 噪声一起修干净
④ 回头重新评估 §2.2                     → 此时大概率只需当兜底写，风险已大幅下降
⑤ 另一份文档：Responses 适配器           → 想上 gpt-5.5 / 5.6 时再做
```

**三条必须知道的前后关系：**

1. **②那步是零成本的，别跳过。** `gpt-5.4` 走**现有** chat/completions 协议，只需在设置页改 model + 勾「支持图片理解」，**不需要任何代码改动**（已实测：文本 ✓ 识图 ✓ 语义矩阵 ✓，1500 token 够用、实际只花 125）。先把"语义链路到底通没通"这个变量排除掉，后面调 §2.3/§2.4 时才不会一边猜模型一边猜代码。
   > 想用 `gpt-5.5` / `5.6-*` 则**必须**先做 Responses 适配器（协议不同），见 `2026-07-26-openai-responses-adapter.md`。

2. **§2.2 是全文风险最高的一项，建议放到 §2.1 验证完之后再评估。** 它会收窄片段时长，**破坏 `Σduration == 口播总时长` 这个从 AI-remix 继承来的核心不变量**（AI-remix 自己也有这个缺口，是靠"段够细所以几乎不触发"来规避的）。§2.1 做完后段长大幅缩短，§2.2 的触发概率随之骤降——到那时它可能只需要作为兜底存在，而不必冒险改时间轴换算逻辑。**先做 §2.1，再决定 §2.2 要做到多深。**

3. **§5 验收里有一条依赖顺序，别误判成"没做对"。** 「语义真正参与（`semanticFallback === false` 且各句选到不同且合理的素材）」这条**依赖语义链路修好**（②或 §2.4）。只做完 §2.1/§2.2 就去对照 §5，会看到「视频轨有画面了，但语义那条过不了」——这是**顺序没到**，不是实现有错。

---

## 1. 逐条差异对照（AI-remix ↔ 我们）

| # | 维度 | AI-remix | 我们（现状） | 后果 |
|---|---|---|---|---|
| 1 | **句段粒度** | `ai_service.py:638` LLM 断句 **5–8 段**（15s 口播），prompt 明写「每个片段对应一句口播画面」 | 继承模块 3 分镜边界，或 `splitNarrationSentences` 正则**只按 。！？； 切、逗号不切** → 22.3s 只切出 **3 段 × 7.4s** | 单场景 5.05s < 7.41s，长度筛选全灭 |
| 2 | **匹配关键词** | 同一次断句调用里 LLM 产出 **3–5 个画面关键词**（沙发/客厅/阅读），与场景描述同构 | `workspace.ts:617` `extractMatchKeywords` 产出**滑窗二字碎片**（忙碌/碌一/一天/天回…） | 关键词相似度实测 **21/21 全 0**；且碎片被一并喂进语义 prompt 成为噪声 |
| 3 | **无可行候选** | `match_solver.py:313-323` **局部回退**：忽略长度，取「有效分 − λ×已用次数」最高者，标 `feasible=False` + `backoff`。**绝不留空** | `audio-first-matcher.ts:443-451` 记 `material_gap` **blocking gap**，该句无画面 | 视频轨整条空白 |
| 4 | **打分调用重试** | `_retry_with_backoff`（指数退避，可重试状态码，`ai_service.py:63`） | `workspace.ts:1067-1078` 裸 `try/catch`，**一次失败即全局降级** | 单次抖动 → 整条时间线零语义 |
| 5 | **降级可见性** | 求解器写 `reason` 字段（"语义首选/覆盖优先/语义降级(兜底)"）逐段可读 | 空 `catch {}`，无日志无留存；UI 直到第 4 步才显示 issues | 排查成本极高 |

### 1.1 移植得很好、**不要动**的部分

以下已高度对齐，改动时不要破坏：

- 最小费用流建图（源→句→场景→视频→汇、副本边递增加价）：`match_solver.py:262-297` ↔ `audio-first-matcher.ts:209-301`。
- 语义地板三取大：`max(abs, red_line, best×(1-rel))`，`match_solver.py:259-260` ↔ `audio-first-matcher.ts:238-239`。
- 参数默认值完全一致：`red_line=0.35`、`coverage_penalty/REUSE_PENALTY=0.15`、`candidate_window=0.10`、`hook_weight=0.2`、`semantic_floor_abs=0.3`、`semantic_floor_rel=0.15`、`min_segment_duration=0.2s`。
- 节拍吸附「相邻段等量反向移动、Σduration 不变」：`match_solver.py:394-436` ↔ `audio-first-matcher.ts:314-377`。
- **时长唯一基准 = TTS 真实时长**（口播主轴），`Σduration == total_duration` 由构造保证 —— 这是 AI-remix 设计文档里消除"结尾冻结"的核心不变量，**必须保持**。

---

## 2. 修复方案（按优先级）

### 2.1 【P0，单条即可解锁主理人当前项目】句段切细，对齐 AI-remix 5–8 段

**现状证据**（真实文案，`data/workbench.db`）：

```
口播全文 116 字，3 句（。×3），逗号 ×7 —— 逗号全部未参与切分
当前切分 = 3 段：38字 / 40字 / 38字  →  TTS 实测 7.41s / 7.49s / 7.42s
```

**AI-remix 做法**（`ai_service.py:638`）：

```
请将以下口播文案按语义自然断句拆分为5-8个片段，每个片段对应一句口播画面。15秒的口播大约150-200字。
对每个片段提取：1.片段文本 2.3-5个画面关键词（用于匹配视频素材） 3.建议时长
注意：duration_hint 仅作上下文参考，真实时长以 TTS 为准，不要在这里臆测精确时长。
```

并配 `_force_split_segments()`（`:694`）作为兜底：LLM 返回段数不足时**按标点强制再切**。

**建议实现**（两选一，可叠加）：

- **(a) 对齐 AI-remix：新增一次 LLM 语义断句**，产出 `{text, keywords[3-5]}`。同时解决差异 #1 和 #2（关键词一并拿到），**最推荐**。
  - 落点：`lib/final-edit/mixcut-script.ts` 或 `workspace.ts` 的 prepare 前段。
  - 注意 `canPreserveBoundaries`（`mixcut-script.ts:104-110`）：当前与模块 3 同步时会**直接继承分镜边界**（每分镜一段，粒度就是粗的）。混剪匹配用的切分应当**独立于模块 3 的分镜边界**——分镜边界是"画面级"，匹配需要的是"口播语义级"。这是设计决策，执行时请在文档里显式记录。
- **(b) 零 LLM 兜底：正则也切逗号**。把 `splitNarrationSentences`（`mixcut-script.ts:70-82`）的 `[^。！？!?；;]+` 扩展为包含 `，,、`，并加最小段长合并（避免切出 2 字碎段）。
  - 本例效果：3 → 10 段，22.32s/10 ≈ 2.2s/段，远小于 5.05s ✅
  - 优点：无 LLM 依赖、确定性、可单测；缺点：断句质量不如语义断句。
  - **建议同时实现**，作为 (a) 失败时的 fallback（对应 AI-remix 的 `_force_split_segments`）。

**约束**：切细后段数变多，注意
- 复用上限 `autoUseLimit`（→ `maxReuse`）要够：10 段 ÷ 7 素材 → 至少允许每素材用 2 次，否则会撞 `reuse_limit` gap。**执行时必须核对默认值。**
- 字幕条数随之变多（每段一条）。确认字幕/对齐链路（`adapters/alignment.ts`）能承受，且观感可接受。
- 最小段长建议 ≥1.2s，避免机关枪式切换。

### 2.2 【P0】无可行候选时绝不留空（照抄 AI-remix 局部回退）

`audio-first-matcher.ts:441-451` 当前：

```ts
const selection = assignments.get(sentence.id);
if (!selection) {
  // …记 gap，该句无画面
  gaps.push({...}); issues.push({...}); continue;
}
```

**改为对齐** `match_solver.py:313-323`：无长度可行候选时，取「有效分 − λ×已用次数」最高的素材，**照常产出片段**，并：
- `feasible = false`、记入 `backoff`；
- 片段时长按素材可给的上限收窄（`match_solver.py:345-349` 的 `d = max(min_segment_duration, c.end - c.start)`）；
- issue severity 从 **blocking 降为 warning**（画面在、只是不理想），文案参考「素材较短/语义降级，已用兜底素材」。

> ⚠️ **收窄时长会破坏 `Σduration == total_duration` 不变量**（AI-remix 自己也有这个缺口，靠"段切得细所以几乎不触发"来规避）。执行者必须决定：收窄后剩余时长如何处理——建议**由下一段提前接入补齐**（即恢复旧铁律 3 的 `clip_short_borrowed_forward` 语义），并在 `audio-first-timeline.ts` 的换算里保证时间轴无缝、无黑场。**这是本项改动的主要风险点，必须有单测覆盖。**

### 2.3 【P1】关键词通道修复

即使 §2.1(a) 拿到了 LLM 关键词，**降级路径仍要能兜住**（LLM 总会偶尔失败）。当前 `keywordSimilarity` 对中文结构性失效（详见 §3.0②）：

- 若走 §2.1(a)：`extractMatchKeywords` 的 bigram 产物应**只作为 (a) 失败时的 fallback**，且需按下面 (i)(ii) 修好。
- (i) **子串包含替代精确相等**：`audio-first-matcher.ts:150 keywordSimilarity` 改为双向子串判定（句子原文是否含标签 / 标签是否含关键词），直接绕开中文分词问题。**推荐**。
- (ii) 修 `extractMatchKeywords:626` 的 `.slice(0, 12)`：当前 12 个名额被首个 chunk 的碎片吃光，**句子后半段完全不参与**。改为按 chunk 均摊或提高上限。
- **不要**把 bigram 碎片继续塞进语义打分 prompt（见 §2.4）。

### 2.4 【P1】语义打分 prompt 与调用对齐

**prompt 内容差异**：

| | AI-remix (`ai_service.py:855-861`) | 我们 (`semantic-matrix.ts:82-87`) |
|---|---|---|
| 句子 | `句{i}: "{text}" 关键词: {LLM画面关键词}` | `JSON.stringify(sentences)` —— 含 **bigram 碎片**噪声 |
| 素材 | `素材{j}: {description}`（干净描述） | `JSON.stringify(scenes)` —— 含 `assetKey/assetFingerprint/startUs/endUs/quality` 等**与语义无关的字段** |

→ 改为**只喂语义信息**（句文本 + 画面关键词；场景描述 + 标签），去掉指纹/时间戳/内部 id 等噪声。

**调用差异**：
- 加**重试**（对齐 `_retry_with_backoff`）：可重试状态码 + 指数退避。
- `maxTokens` 的 **1500 是忠实照搬 AI-remix 的**（`ai_service.py:887` 也是 1500）——**不是当初写错**。差异在**模型**：AI-remix 用普通文本模型，我们配的是**思考型** `gemini-3-flash-preview`，思考 token 计入输出预算，1500 极易被吃光返回空。
  → 处置：**先实跑确认失败形态**（空文本 / 超时 / JSON 形状不符），再决定是取消硬编码（继承 provider 的 8192）还是按 `n×m` 规模动态估算。**不要凭推断直接改数值。**

> **另一条解法：换模型。** 2026-07-26 实测 `gpt-5.4`（走现有 chat/completions，改配置即可）与 `gpt-5.5`（走 Responses 协议，需新增适配器）在本 prompt 上均能稳定返回合格矩阵，且 **gpt-5.5 的语义区分度显著优于当前降级状态**（逐句精准命中，实测数据见另一文档 §2.3）。
> 详见 **`2026-07-26-openai-responses-adapter.md`**。
> ⚠️ 换模型**不能**替代 §2.1（切句）——那是我们代码里的正则，不走 LLM。两件事必须并行修。
- 补日志：`workspace.ts:1076` 的空 `catch {}` 必须留错误原因。
- **保持不动**：`workspace.ts:1079-1081` 的「fallback 结果不写缓存」自愈逻辑是对的。

### 2.5 【P2】降级可见性

- 对齐 AI-remix 的逐段 `reason` 字段（`match_solver.py:453-465`：`score=0.82 语义首选(首次使用)`）。我们已有 `matchDiagnostics`，可在第 3 步预览的片段选中态展示。
- 第 3 步预览的 blocking issues 横幅已于 2026-07-26 加上（`PreviewStep.tsx`），warning 级别也应可见（样式区分：黄 ≠ 红）。

---

## 3. 附：语义为何"完全没参与"的实测（背景，已在 §1 表格中归因）

### 3.0 三层塌陷

**① 语义分变常量 → 零区分度，且语义红线一并失效。**
`semantic-matrix.ts:55-61` fallback 返回全 `0.6` 矩阵，常量在成本比较中完全抵消。
地板计算 `audio-first-matcher.ts:238-239`：`max(0.3, 0.35, 0.6×0.85=0.51) = 0.51`，而每个候选都是 `0.6 > 0.51`
→ **没有任何候选被判 `belowFloor`** → `BELOW_FLOOR_COST = 1e9` 的语义红线**一次都不触发**。

**② 关键词降级通道实测全 0（21/21）。**
用真实数据复刻 `extractMatchKeywords` + `keywordSimilarity`：

```
句段1 提取关键词: 忙碌 碌一 一天 天回 回到 到家 只想 想陷 陷进 进这 …（12 个上限）
素材场景标签:     ["女性","黑色皮沙发","阅读","实木茶几","现代客厅","居家场景"]
3 句 × 7 素材 = 21 对，keywordSimilarity 全部 = 0.000
```

结构性原因：滑窗二字碎片 × **精确集合相交** × 完整语义标签（3–5 字）→ 数学上几乎不可能命中；且 12 名额被首 chunk 吃光，"5芯软弹""人体工学靠背""半青皮"等真正卖点词**根本没进入匹配**。

**③ 于是实际决定选材的只剩（成本量级，`COST_SCALE=1e6`）：**

| 信号 | 成本权重 | 现状 |
|---|---|---|
| 复用惩罚 `REUSE_PENALTY×useIndex` | 150,000/次 | 生效 |
| 同分镜 `sameShotPrior` | 100,000 | 生效 |
| 画质 `quality×0.001` | ~30 | 极弱（实测 0.92~0.95） |
| `flatIndex` 兜底 | 0~6 | 文件顺序 |
| **语义 `semantic`** | **0** | **完全失效** |
| 首镜 `hook` | 0 | fallback 时 `hookScores` 全 0 |

→ **当前 = 「同分镜优先 + 不重复 + 画质微调」的结构排序，零语义理解。**

### 3.1 真实数据（分镜组「01」`c33b88f0…`，组 `93687520…`）

```
7 个素材：每个 1 个场景 = 全长 5.05s（全库最长单场景 5.05s）
3 个句段：7.41s / 7.49s / 7.42s
matchDiagnostics: feasible=false, usedMaterials=[], totalMaterials=7,
                  gaps=3×insufficient_duration, semanticFallback=true
分析器：gemini / gemini-3-flash-preview / analyzerVersion=2 / 7×succeeded
```

---

## 4. 测试要求

- **新增单测**（Node 22 原生 TS，`node scripts/<name>.test.ts`）：
  - **切分**：真实文案（§3.1）→ 断言切出 5–10 段、每段 ≤ 最大可用场景时长、无 <1.2s 碎段。
  - **短素材端到端**：7×5.05s 素材 + 切细后的句段 → `feasible === true`、`gaps` 为空、时间轴无缝覆盖 `[0, narrationDuration)`。
  - **无可行候选兜底**（§2.2）：构造一个所有素材都不够长的场景 → **不得留空**，须产出片段 + `feasible=false` + warning 级 issue；断言时间轴仍无缝。
  - **关键词**（§2.3）：用 §3.1 的真实句段 + 真实标签，断言相似度**不再全 0**；语义正常时该项仍被 `×0.02` 压制（`audio-first-matcher.ts:185`）。
  - **防回归**：素材足够长时，输出与改动前一致。
  - **复用上限**：切细后段数 > 素材数时，`maxReuse` 足够则不得出现 `reuse_limit` gap。
- **既有测试全绿**：全量 `scripts/*.test.ts`，重点 `final-edit-workspace.test.ts`、`audio-first-*`、TTS/对齐相关。
- **两个 Playwright**：`final-edit-mixcut.playwright.test.mjs`（mock UI）、`final-edit-mixcut-real.playwright.test.mjs`（真实 E2E，需先 `npm run build`）。
  > 注：mock E2E 已于 2026-07-26 补入两条回归用例（`preparedGroup` 未就绪时的网格布局、blocking issues 横幅），不要破坏。
- `npm run lint` 0 error、`npm run build` exit 0。

## 5. 验收标准

- 用主理人真实分镜组「01」的这批 **7×5.05s 素材**重跑准备任务：视频轨**有画面**，`feasible === true`，`usedMaterials.length ≥ 5`。
- **语义真正参与**：`semanticFallback === false`，且 `matchDiagnostics.reason`/诊断能看出不同句段选到**不同且合理**的素材——而非「同分镜顺序 + 画质」的机械排序。
- 降级路径可用：人为让 LLM 失败时，关键词相似度不再恒为 0，且有明确日志 + UI warning。
- 成片时长仍等于「封面片头 + 真实口播总时长」（**口播主轴不变量**）。
- 渲染产物无黑场/冻结（真实 E2E 的 `blackdetect`/`freezedetect` 继续通过）。

## 6. 边界与非目标

- **不改**求解器的图结构、语义地板公式、红线/复用/窗口等参数默认值（§1.1 已列，与 AI-remix 逐项一致）。
- **不改**渲染/导出管线、V2 UI 布局（已落地验收）。
- **口播主轴不变**：成片时长 ≈ 真实 TTS 总时长。
- 不引入新的重型依赖（AI-remix 求解器本身零第三方依赖，我们也应保持）。

## 7. 证据附录（file:line）

**我们**
- 长度筛选：`lib/final-edit/audio-first-matcher.ts:162`（`isLengthFeasible`）、`:236-237`、`:443-451`（gap 归因）。
- 求解器：`audio-first-matcher.ts:209-301`；打分：`:174-192`；地板：`:238-239`；关键词：`:150-160`、`:185`。
- 切分：`lib/final-edit/mixcut-script.ts:70-82`（正则）、`:104-110`（继承模块 3 边界）。
- 关键词生成：`lib/final-edit/workspace.ts:617-627`。
- 语义矩阵：`workspace.ts:1067-1096`（调用/缓存/空 catch）、`:1074`（maxTokens 1500）、`lib/final-edit/semantic-matrix.ts:63-87`。
- 下游转换：`lib/final-edit/audio-first-timeline.ts:19-58`。
- issues 组装：`workspace.ts:1137-1146`。

**AI-remix**（`/Users/liangpeijian/for-cc/AI-mixcut/AI-remix-master/short-video-mashup-tool`）
- 求解器：`backend/services/match_solver.py`（长度约束 `:253`、**无候选局部回退 `:313-323`**、时长收窄 `:345-349`、地板 `:259-260`、建图 `:262-297`、吸附 `:394-436`、reason `:453-465`）。
- 断句 + 画面关键词：`backend/services/ai_service.py:638`（prompt）、`:694`（`_force_split_segments` 兜底）。
- 语义打分：`ai_service.py:855-861`（prompt 组装）、`:887`（max_tokens 1500）、`:63`（`_retry_with_backoff`）。
- 场景检测参数：`backend/config.py:278-282`（threshold 20 / min 0.3s，与我们 `lib/final-edit/scene-detect.ts:41` 一致）。
- 设计文档：`docs/design-match-audio-first.md`（§1.1 三大难点与解法、时长不变量论证）。

**历史（旧管线，已删除，仅供理解铁律 3）**
- `.worktrees/script-driven-arrangement/lib/final-video/solve-timeline.ts:143-145`（`clip_short_borrowed_forward`）、`:148-187`（末帧定格）。
- 铁律出处：`docs/superpowers/specs/2026-07-12-script-driven-arrangement-design.md:41,157,208`。
- 主线删除记录：commit `13242db refactor(final-video): remove packaging module for rebuild`。

**真实数据**
- 项目 `ab40db9a-87a7-4cf7-be3e-0b04ee8e9524`（ps691-b）、分镜组 `c33b88f0-0f00-4c4d-98e7-65077b663520`、组 `93687520-d330-41ea-ba3b-810dee74907d`、variant `prepare-19ac266b3b270d2e1d77458ac877a012`。

## 8. 相关文档

- **OpenAI Responses 适配器（启用 gpt-5.5/5.6）**：`2026-07-26-openai-responses-adapter.md` —— 与本文档 §3 互补，可并行执行
- V2 UI 规格（已落地）：`../specs/2026-07-25-mixcut-v2-ui-spec.md`
- V2 重构计划（**Part B 后台并行提速仍未做**）：`2026-07-25-mixcut-v2-reconstruction-plan.md`
- AI-remix 移植执行文档：`../specs/2026-07-23-mixcut-port-from-ai-remix.md`
