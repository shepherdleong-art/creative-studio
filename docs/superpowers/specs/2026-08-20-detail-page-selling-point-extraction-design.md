# 详情页卖点提取设计（脚本生成 Step 0）

日期：2026-08-20
状态：设计稿，等真实详情页样本后补全「待验证清单」再进入实现

## 目标

- 用户上传 1–2 张超长详情页图，由多模态模型读出卖点候选，用户确认后进入现有排序与脚本生成。
- 取代「人工逐条手打卖点」这一步，但**不删除**手打路径。
- 不改动 `analyzeScriptStrategyV3` 的输入输出契约。

## 当前事实

以下全部经代码核对，实现时不要重新假设。

### 现有三步与契约

| 步骤 | 入口 | 契约 |
| --- | --- | --- |
| ① 卖点 | `components/ScriptSellingPointInput.tsx` 文本框 | 产出 `sellingPoints: string[]` |
| ② 策略 | `analyzeScriptStrategyV3`（`lib/script-generation-v3.ts:893`） | 纯文本调用，提示词内**明确禁止看图** |
| ③ 脚本 | `generateScriptV3` | 已是多模态，分镜图经 `completeJson` 的 `images[]` |

- 排序**已经存在且在服务端**：模型只给 `audienceFit / platformFit / sellingPointStrength` 三项 1–5 分，最终名次由 `analysisFactorScore` 按 40% / 35% / 25% 加权算出，模型自报的 `rank` 仅用于破同分。本功能**不重做排序**。
- 卖点 ID 由 `stableSellingPointId(title)`（`lib/script-generation-v3.ts:711`）对标题取 SHA-256 前 16 位得到。
- `buildAnalysisSellingPoints`（`lib/script-generation-v3.ts:716`）遇到重复标题**直接抛** `duplicate_input_selling_point`。
- `analyzeScriptStrategyV3` 在 `targetAudience` 为空时直接抛错，目标人群仍是必填。

### 视觉调用链路（已存在）

- `completeJson`（`lib/script-providers/index.ts:110`）已支持 `images[]`。
- **公司 scope（Luna 走这条）**：每张图经 `tryUploadBufferToCosAndSign` 上传腾讯 COS，模型收到的是预签名 URL，**请求体里没有 base64**。上传是 `Promise.all` 并行。
- COS 对象按内容 SHA-256 命名，上传前用 `Range: bytes=0-0` 探测是否已存在。**同一张详情页重跑不会重复上传**，调提示词的边际成本接近零。
- 门禁：LiteLLM 代理未起或 COS 未配置时，`provider-execution-gate` 以 `transport_unavailable` **失败关闭**，不降级、不内联。

### Luna 的具体约束

- 供应商 id `gpt`，模型 `GPT-5-6-Luna-Standard`，`executionScope='company'`，`supportsVision=1`（`lib/seed.ts:351-390`）。
- **temperature 不可调**：`isDefaultTemperatureOnlyModel` 命中 `^GPT-5-6-Luna`，`lib/script-providers/openai-compatible.ts:106` 强制 `temperature=1`。
  → 设计含义：**不能靠低温度稳住结构化输出**，必须靠严格 schema + 校验重试循环补偿。
- 图片以 `image_url: { url }` 形式挂在 user message 上，**当前没有传 `detail` 参数**（`lib/script-providers/openai-compatible.ts:92`），走上游默认。小字 OCR 是否需要 `detail: high` 属待验证项。

### 现有视觉预算与本功能的关系

- `SCRIPT_VISION_TOTAL_RAW_BYTES = 4MiB`、单图 384KiB、长边 1024（`lib/script-vision-image.ts`）。
- 该预算服务于**分镜图**，其压缩阶梯（先降 JPEG 质量、后降分辨率）不适合文字图。
- 详情页按本文切法后总字节约 2–3MiB，本就碰不到该预算；**本功能不依赖 4MiB 的任何调整**，两件事解耦。
- 4MiB 常量本身的调查结论见文末附录。

## 未决输入（本设计因此必须自适应）

- 详情页**宽度未知**（750 / 790 / 1200 均有可能）。
- 详情页**高度不统一**，随卖点条数变化。
- 因此切片参数**不得硬编码**，必须由实测宽高推导。

## 设计

### A. 输入与存储

- **上传**：复用 `POST /api/upload`。
  - `role='input'`（`reference` 上限只有 3 张，且语义不符）
  - 新增 `usage='product_detail'`，加入 `app/api/upload/route.ts:57` 的白名单
  - **必须传 `preprocessEnabled=false`**：默认预处理会把长边缩到 1536，长图会被毁掉
  - 切片一律读 `originalPath`（原图始终完整保留）
- **切片产物**：写到 `storage/detail-page-tiles/<imageAssetId>/<index>.jpg`，文件名确定性、可重算、不落库。供 UI 回看「这条卖点来自哪一片」。
- **提取结果**：新增列 `projects.sellingPointCandidatesJson`，在 `CORE_DB_MIGRATIONS` 追加一条 `ALTER TABLE`（该流是 append-only，不得改动既有条目）。

### B. 切片（本功能的核心）

新建 `lib/detail-page-tiles.ts`，与 `script-vision-image.ts` 平级。**不要改后者** —— 它服务分镜图，有自己的假设。

**自适应规则**

```
MAX_TILE_EDGE     = 1024   （可配；样本验证后可能上调到 1536）
OVERLAP_RATIO     = 0.12
MAX_TILES         = 40
MAX_SOURCE_PIXELS = 60_000_000

1. 若 W > MAX_TILE_EDGE，整图等比缩到宽 = MAX_TILE_EDGE；否则不缩。
2. 切片高度 = MAX_TILE_EDGE（缩放后坐标系）。
3. 于是每片尺寸 = min(W, MAX_TILE_EDGE) × MAX_TILE_EDGE，长边恰好等于上限，
   **不需要二次缩放**，文字保持原生分辨率。
4. 步进 = 切片高度 × (1 - OVERLAP_RATIO)。
5. 片数超过 MAX_TILES 时，等比增大切片高度直到片数达标，并向用户显示
   「详情页过长，文字清晰度已降低」的明确警告 —— 降级，不拒绝。
```

W=750、MAX_TILE_EDGE=1024 时每片 750×1024，**一个像素都不缩**；H=15000 约切 17 片。

**重叠是必须的。** 被拦腰切断的句子或参数表行，必须在相邻片里完整出现一次，否则模型只能看到半句。

**编码**：JPEG q88。文字对 JPEG 质量比照片敏感（汉字边缘振铃），不要走 `prepareScriptVisionImage` 的 78→68→52→45 降质阶梯。

**解码性能**：逐片 `sharp(buffer).extract()` 会把整张长图重复解码 N 次。正确做法是先 `.raw().toBuffer()` 解码一次，再对同一份像素缓冲逐片 `extract`。750×15000 的 raw 约 33MB，可接受；超过 `MAX_SOURCE_PIXELS` 时先整体等比缩小再切。

**智能切点属 v2**：检测水平低方差空白带、在附近微调切点以避开文字行。v1 靠重叠兜住，不做。

### C. 提取调用

- **一次请求**塞全部切片。视觉计费按面积算，切成几片不影响总价；分批只增加往返开销。
- 两张详情页：切片序列首尾相接，提示词里用 `page` 字段区分，保留跨页上下文。
- `maxTokens` 至少 4000（17 片可能产出 20–30 条带证据的候选）。
- 复用 `analyzeScriptStrategyV3` 的**校验重试循环形态**：产出 → 服务端校验 → 把逐条 `validationIssues` 连同 `previousResult` 回灌重写，最多 3 次。Luna 不能调温度，这个循环是唯一的稳定性来源。

**输出契约（草案）**

```jsonc
{
  "productGuess": { "name": "string", "category": "string" },
  "audienceHint": "string",            // 仅作预填建议，不自动采用
  "candidates": [{
    "id": "sp-1",                       // 提取阶段临时 ID，不进入下游
    "title": "string，12 字以内的卖点短句",
    "evidence": "string，详情页上的原文片段",
    "tileRefs": ["tile-3", "tile-4"],
    "kind": "spec | material | function | scene | service | promo",
    "confidence": "high | medium | low",
    "riskFlags": ["absolute_term", "unverifiable_claim"]
  }]
}
```

**写进 requirements 的硬规则**

- `evidence` 必须是详情页上**看得见的原文**，禁止改写、禁止推断。「钢板加厚」不得推成「承重 300kg」。
- 同一卖点在多片重复出现时合并成一条，`tileRefs` 列全。详情页天然会把同一个卖点重复三遍（头图 banner、参数表、卖点图）。
- 促销、物流、售后（包邮、七天无理由、赠品）标 `kind=promo`，默认不进脚本。
- 极限词（最、第一、国家级、顶级）标 `riskFlags:[absolute_term]`。提取阶段是拦这类词最便宜的位置。

### D. 归一化与去重（服务端，不信任模型输出）

1. 标题 NFKC 归一化、去空白、去标点后比较，重复项合并（保留 `evidence` 更长的那条）。
   **这一步是硬性的** —— 不去重会让下游 `buildAnalysisSellingPoints` 直接抛错，整个分析 400。
2. `title` 或 `evidence` 为空的条目丢弃。
3. `tileRefs` 引用了不存在的片号 → 记 `validationIssue`，触发重写。
4. 总数截到 30 条。

### E. 用户确认（不可跳过）

- 候选列表默认勾选 `confidence ∈ {high, medium}` 且 `kind ≠ promo` 的条目。
- 每条可编辑标题、展开看 `evidence`、点 `tileRefs` 跳转到对应切片预览。
- 带 `riskFlags` 的条目高亮提示，但不强制取消 —— 由用户决定。
- 保留「手动新增一条」的入口。
- 确认后调用**现有**接口：`POST /api/projects/[id]/script`，`action=analyze`，`sellingPoints: string[]`。

**为什么这一步不能省**：下游所有模板的 `writingRules` 都建立在「卖点是已核实事实」这个前提上（`lib/script-templates.ts`），`generateScriptV3` 的 `sellingPointUsage` 也是围绕它设计的。跳过人工确认等于把模型幻觉洗成「已验证卖点」，比人工输入更危险。

### F. ID 稳定性

- 提取阶段的 `sp-<n>` 是临时的，**不进入下游**。
- 下游 ID 仍由现有 `stableSellingPointId` 从**用户确认后的最终标题**计算。
- 重新提取产生新的候选集，**不得静默覆盖** 已有的 `projects.sellingPointAnalysisJson`；是否重新分析由用户决定。否则重跑一次、措辞微调，已保存的分析和勾选会全部失配。

### G. 同步还是任务化

v1 **做同步**，与现有 `analyze` 保持一致。

- 现有 analyze 已是同步且内含最多 3 次 LLM 往返，先例成立。
- 本地服务没有平台级请求超时，两分钟的同步请求实际可用。
- 代价：没有进度、不能取消。用明确的加载文案兜住。
- 实测耗时后若确实难受，再接 `lib/script-generation-manager.ts` 那套（进度 / 取消 / shutdown 感知）。**任务化是纯工程量，不影响任何契约，随时可加**。

## 数据流

1. 用户上传 1–2 张详情页（`usage=product_detail`，不预处理）。
2. 服务端读 `originalPath` → `lib/detail-page-tiles.ts` 自适应切片 → 落 `storage/detail-page-tiles/`。
3. 全部切片一次性交给 `completeJson`（Luna，公司 scope → 并行上传 COS → 预签名 URL）。
4. 模型返回候选 → 服务端归一化去重校验，失败则回灌 `validationIssues` 重写（≤3 次）。
5. 结果写入 `projects.sellingPointCandidatesJson`，返回前端。
6. 用户勾选 / 编辑 / 补充。
7. 确认的标题数组送入**现有** `action=analyze` → `analyzeScriptStrategyV3` 排序。
8. 之后完全走现有第 2、3 步，无改动。

## 错误与兼容性

- LiteLLM 未起或 COS 未配置 → 沿用 `transport_unavailable` 失败关闭，文案要指向「启动公司模型代理 / 配置 COS 密钥」。
- 非图片、损坏图片、超 `MAX_SOURCE_PIXELS` → 明确 400，不静默截断。
- 详情页过长触发降级 → 成功但带警告，不拒绝。
- 三次重写仍不合规 → 沿用 `ScriptGenerationV3Error` 形态返回，附 `validationIssues` 供排查。
- 完全不改动手打卖点路径；已有项目的 `sellingPointsJson` / `sellingPointAnalysisJson` 不迁移、不改写。
- 不改 `analyzeScriptStrategyV3`、`generateScriptV3` 的任何契约。

## 测试与验收

- `lib/detail-page-tiles.ts` 单测：极端宽高比、W 大于/小于上限、重叠正确、片数上限触发降级、总面积覆盖无缺口。
- 归一化去重单测：重复标题必须在进入 `buildAnalysisSellingPoints` **之前**被合并（这是硬失败点，必须有回归测试锁住）。
- 契约校验单测：缺字段、`tileRefs` 越界、`evidence` 为空 → 产出可操作的 `validationIssues`。
- 端到端：一张真实详情页跑通「上传 → 切片 → 提取 → 确认 → 现有分析 → 现有脚本」。
- 运行相关独立测试与 ESLint。

## 非目标

- 不改 `analyzeScriptStrategyV3` 契约，不把它改成多模态。
- 不改 `MAX_SHOTS_PER_SET`（20）与 `SHOT_VISION_FULL_QUALITY_MAX`（10）—— 另一笔账。
- 不做自动发布：人工确认环节不可跳过。
- v1 不做智能切点、不做 map-reduce 分批。
- 不处理 PDF、视频形态的详情页。
- 不在提取阶段做合规判定，只打标签，判断权在用户。

## 待验证清单（拿到真实样本后逐条填）

| # | 待验证 | 影响 |
| --- | --- | --- |
| 1 | 详情页实际宽度 | 定 `MAX_TILE_EDGE`，决定是否需要整体缩放 |
| 2 | 最小文字尺寸（参数表、角标） | 1024 够不够，不够则上调到 1536 |
| 3 | Luna 单次请求可接受的图片张数上限 | 17 片能否一次塞完；不行才考虑分批 |
| 4 | Luna 中文 OCR 质量（参数表能否读对） | 决定功能是否成立；不行要换视觉模型 |
| 5 | `image_url` 是否需要补 `detail: high` | 小字识别率；当前走默认 auto |
| 6 | 实际 token 计费 | 估算约 5000 token / 张，用现有用量看板读实测值 |
| 7 | 端到端耗时 | 决定是否需要任务化 |
| 8 | 两张详情页是「一个产品拆两张」还是「两个产品」 | 前者接成连续序列，后者必须分开处理 |

估算口径：视觉 token 按面积算，750×15000 约 1100 万像素，粗估约 5000 token。**该数字未经实测**，第 6 项验证后以实际用量为准。

---

## 附录：`SCRIPT_VISION_TOTAL_RAW_BYTES = 4MiB` 的调查结论

与本功能无关，但调查过程中发现，记录备查。

- 该常量在 `54d4c35`（2026-07-29，"Fix script generation and add progress cancellation"）随多模态支持一并引入，**没有任何提交说明或设计文档解释为什么是 4MiB**，也不对应任何已核实的供应商限制。
- `docs/superpowers/specs/2026-08-17-storyboard-20-shot-and-concurrency-defaults-design.md` 在「当前事实」里提到了它，但那是**把它当既定前提继承**，不是论证它。
- 它比 `lib/cos-media.ts` 的 COS 集成（`416627d`，2026-08-05）**早一周**，因此不可能是为 COS 定的。COS 那边有自己独立的一套阈值（普通图 2MiB、视频帧 4.8MiB），理由分别是「为 14 人团队控制流量」和「腾讯 CreateAigcVideoTask 首帧 10M / 尾帧 5M 限制」，与此无关。
- 它现在是承重墙：`MAX_SHOTS_PER_SET = 20` 与 `SHOT_VISION_FULL_QUALITY_MAX = 10`（`lib/shot-set-domain.ts`）都是从它反推的，后者还直接显示为用户可见的画质警告（`components/ScriptStrategyConfig.tsx:246`）。
- 它量错了维度：`prepareScriptVisionImage` 的降级阶梯**先降 JPEG 质量、后降分辨率**，而视觉 token 只与像素尺寸相关。11–20 张分镜的典型情况下，降的是质量、分辨率仍是 1024 —— **画质白降，token 一分没省**。
- 走公司 scope 时更无意义：图片经 COS 以 URL 形式传递，base64 根本不进请求体。
- 4MiB 总预算**没有任何测试覆盖**（`scripts/script-vision-image.test.ts` 只断言单图 384KiB 与长边 1024）。

**建议的独立改动**（不属于本功能）：拆掉总字节预算或抬到不再生效的水平，保留每张 1024 像素上限，同步移除 `SHOT_VISION_FULL_QUALITY_MAX` 那条用户警告。收益是 11–20 张的分镜组不再被无谓压画质。`MAX_SHOTS_PER_SET` 建议维持 20 —— 它现在有「图多则模型注意力分散」这个独立理由，且 `scripts/shot-set-domain.test.ts:10` 已把它锁成有意的产品决策。
