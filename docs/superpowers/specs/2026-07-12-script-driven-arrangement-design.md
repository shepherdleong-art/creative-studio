# 脚本主导编排（Script-Driven Arrangement）设计

> 状态：已与产品负责人逐条确认（2026-07-12 grill）
> 取代：`docs/superpowers/plans/2026-07-07-final-video-orchestration-redesign.md` 中"AI 在成片阶段编排"的部分
> 范围：本 spec 只覆盖 **Round 1**。成片包装的界面重做（横向时间轴）是 **Round 2**，另开 spec。

## 1. 病根

现有 5 步流程：新场景图生成(1) → 分镜生成(2) → **脚本生成(3)** → 视频生成(4) → 成片包装(5)。

**脚本生成是瞎写的。** 喂给 LLM 的"画面信息"是**图片文件名字符串**，不是图片：

- `app/api/projects/[id]/script/route.ts:170-175` — `ShotContext` 的 `description` 字段直接取 `r.sourceFilename`
- `lib/script-providers/openai-compatible.ts:242` — prompt 里渲染成 `分镜 {shotIndex}（shotId=...）：{sourceFilename}`
- `chatCompletion`（`openai-compatible.ts:30-84`）和 `geminiCall`（`gemini.ts:187-209`）都只发纯文本，**没有任何 image part**

后果：**文案会描述画面里根本不存在的东西**（产品负责人原话："基本等于瞎写，那等于没用"）。

**而且脚本什么都控制不了。** 它是一个纯叶子节点：

- 上游：`route.ts:156` 按 `ORDER BY s.indexNum` 读分镜，`validateAndNormalizeScript`（`route.ts:274-345`）**强制把输出裁剪/补齐成与分镜数严格 1:1**。而 `indexNum` 是分镜组创建时按点选顺序一次写死的（`app/api/projects/[id]/shot-sets/route.ts:69-71`），此后**任何路由都不会更新它**。产品负责人确认：**这个顺序是随手点的，没有叙事含义**。
- 下游：视频生成**完全不读脚本**（`visualIntent` 字段生成后只用于界面展示和 ZIP 导出）。成片包装则把脚本**压成一坨纯文本**（`lib/final-video/prepare-draft.ts:40-61` 的 `resolveSourceText`），再调 LLM **重新切句**（`narration-script.ts:38` 的 prompt 明写「不要把句子绑定到镜头、分镜或画面」），最后调 LLM **从零发明一个画面顺序**（`orchestrate.ts:64-94`）。

**所以现状是：照着一个无意义的顺序、蒙着眼睛写文案，然后在成片阶段用 vision 把瞎写的句子重新匹配回画面。** 第 5 步的 vision 看的图是对的（`clip-pool.ts:54,70` 读 `video_jobs.sourceImageId`，而 `video-jobs/route.ts:48` 写入的是 `shot.latestGeneratedImageId`——就是第 2 步产出的新分镜图），但它只能在一堆瞎写的句子里做最优匹配，**改不了句子本身**。

### 1.1 附带发现的两个坑

- **成片包装的"目标时长"是个装饰品。** 脚本在第 3 步吃一个自由文本 `duration`（`openai-compatible.ts:245`），成片包装在第 5 步吃一个数字 `targetDurationSec`。但 v2 的铁律是"口播决定成片时长"——脚本按"30秒"写完，TTS 出来就是 30 秒，第 5 步填"20"**什么也改变不了**，只会甩一个 `target_duration_out_of_tolerance` 警告。时长本质是**脚本层的决策**，控制器放错了地方。
- **分镜图生成失败时，视频会拿导入的原图去做。** `video-jobs/route.ts:48` 是 `shot.latestGeneratedImageId || shot.sourceImageId`——回退到原图，而原图里**没有用户的产品**。与本次改动无关，但已记录。

## 2. 核心决策

**把编排决策从第 5 步前移到第 3 步。脚本看着真图写作，并决定画面的选择与顺序。**

这**没有推翻** 2026-07-07 v2 的内核——"口播是主轴、成片时长由真实 TTS 决定、确定性 solver 精算秒数"完全保留。改变的只是**编排决策发生在哪一步**，而且是**净删除**。

### 2.1 最终模型（铁律）

1. **一句口播 = 一张画面 = 一段视频。** 段时长 = 这句话 TTS 的真实时长。
2. **素材比句子长** → 裁掉尾巴（常态）。
3. **素材比句子短** → 下一张图提前进场顶上，红标提示。**这是 `solve-timeline.ts:145` 已有的 `clip_short_borrowed_forward` 行为，无需新代码。**
4. **画面用完了口播还没完** → 才定格（`ffmpeg-graph.ts:108` 的 `tpad=stop_mode=clone`，复制末帧，不是黑屏）。
5. **没有 4 秒上限、没有 beat 切分、没有 `groupId`、没有慢放。溢出不用备用图垫**（备用池只用于替补"素材缺失"，见 §6.2；溢出走铁律 3）。
6. **文案优先**：目标时长决定写多少文案；脚本从 8-9 张候选里**挑它需要的 5-6 张**，剩下的进备用池。
7. **顺序是计划不是合同**：计划里的图缺席就跳过/替补 + 红标；分镜图重生成只软提醒，不硬拦。

### 2.2 为什么 4 秒上限必须去掉

`maxClipSeconds = 4` 是 v2 引入的硬闸门。它**是漂移的唯一来源**：一句话超过 4 秒就得吃两张图，后面全体错位，讲钢架的那句就配到客厅远景上——**正是本次要治的病**。

去掉它，"一句话 = 一张图"永远成立，于是这一整套机制**当场变成死代码**：beat 窗口切分（把长句按 4 秒切成多个窗口）、`groupId`（把切碎的 beat 拼回整句给字幕用）、以及为吸收溢出而设计的一切。

**上限不是消失了，是从"4 秒"变成"素材的物理长度"**（一般 5 秒）。而实测数据支持这个取舍：6 条素材 × 5 秒 = 30 秒素材；20 秒口播配 6 句话 → 平均每句 3.3 秒。**每条素材天然有 1.7 秒余量**，偶发的一两秒超出会被下一张图一口吞掉，游标随即追平，**漂移自动收敛、不滚雪球**。

## 3. 范围

### Round 1（本 spec）

| 层 | 改动 |
|---|---|
| **第 3 步 脚本生成** | 多模态看真图；挑图 + 排序 + 一句配一图；目标时长收归此处（改为数字）；去掉"必须和分镜数 1:1"的强制 |
| **第 5 步 成片引擎** | `prepare-draft` 改为消费脚本的计划；删 `orchestrate.ts` / `vision.ts` / `narration-script.ts`；去掉 `maxClipSeconds`；`solve-timeline.ts` 几乎不动 |
| **第 5 步 界面** | **只做减法**：删掉因步骤消失而失效的 5 个字段。**不重新设计。** |

**为什么第 5 步引擎必须一起改：** 脚本产出的计划，现有第 5 步代码**根本不会去读**（见 §1）。只做第 3 步，成片一点变化都没有。

### Round 2（另开 spec，不在本次）

成片包装界面重做为**横向时间轴编辑器**（每段宽度 ∝ 时长，点击色块换片，上方大预览窗口）。产品负责人已选定此方向（"对于剪辑师来说更加直观"）。

### 明确不动

- **分镜生成（第 2 步）的顺序机制** — 产品负责人确认"顺序不重要，它的重点只是生成新的分镜"。仅修正 `ShotSetPanel.tsx:530/548` 的误导文案（现在写的是"点击顺序即为分镜顺序"，改为说明顺序由脚本决定）。
- **视频生成（第 4 步）** — 继续为分镜组里**所有**分镜生成视频。没被脚本选中的即备用池。产品负责人明确不在意这部分消耗（"正常消耗来的"）。
- **纯 BGM 模式** — 它走 `solve-bgm-timeline.ts` 的 `selectedClipIds`（用户手选片段+手动排序），本来就不碰脚本和 AI。**一行不改。**
- **脚本供应商** — Gemini / Qwen / Kimi / GPT 四家全留，不做筛选、不做删除。产品负责人确认四家都具备识图能力。供应商统一是**以后**的事。

## 4. 数据契约

### 4.1 脚本生成的输入（新增）

- `targetDurationSec: number` —— **取代**现有的自由文本 `duration: string`。
- **分镜图本身**（多模态 image parts）。每张图取 `shots.latestGeneratedImageId`，为空则回退 `shots.sourceImageId`（与 `video-jobs/route.ts:48` 的取图逻辑保持一致，确保脚本看到的**就是**将来做成视频的那张图）。
- 无生成图的分镜（`latestGeneratedImageId` 为空且无 `sourceImageId`）**不进候选**。

**一段式，不做两段式。** 直接把图喂给写稿模型，不先跑 vision 转成文字再喂。理由：文字描述是有损的（"一张现代客厅的绿色沙发"会丢掉"扶手的双面走线"这种**恰恰能拿来当卖点**的细节）；而两段式换来的缓存收益，在 Gemini Flash 上不值得引入一个缓存层 + 一个独立识别步骤 + 一个有损瓶颈。产品负责人在 Gemini 官网就是这么用的，有直接经验证据。

### 4.2 脚本生成的输出（`script_drafts.outputJson`）

```jsonc
{
  "version": 2,                    // 用于区分旧格式，见 §7
  "title": "...",
  "targetDurationSec": 20,
  "fullScript": "...",             // 各 segment narration 的拼接（派生字段）
  "segments": [                    // 数组顺序 = 叙事顺序 = 成片画面顺序
    {
      "shotId": "...",             // 这一段展示哪个分镜的画面
      "imageAssetId": "...",       // 写作时看的是哪张图，用于过期检测（§6.2）
      "narration": "回家想躺着，家里的沙发却坐得你腰酸背疼",
      "subtitle": "...",           // 通常等于 narration
      "rationale": "这张图是沙发正面全景，适合开场建立场景"  // 为什么选它 / 它展示了什么
    }
  ],
  "droppedShots": [                // 没被选中的分镜 = 备用池
    { "shotId": "...", "reason": "与已选画面重复，同角度同构图" }
  ]
}
```

**与旧格式的关键差异：**

| | 旧 | 新 |
|---|---|---|
| 数组字段 | `shots[]` | `segments[]` |
| 是否覆盖全部分镜 | **强制 1:1**（`route.ts:301-317` 硬裁剪/补齐） | **选子集**，未选的进 `droppedShots` |
| 数组顺序含义 | 无（被强制成 `indexNum` 序） | **叙事顺序，即成片画面顺序** |
| 每项的 `duration` | 模型瞎猜的字符串（"0-5s"） | **删除**。时长由 TTS 真实决定 |
| `visualIntent` | 模型凭空编的"叙事作用" | **改为 `rationale`**：基于真图的观察 + 选它的理由 |

`rationale` 顺带取代了 `lib/final-video/vision.ts` 的产物——第 5 步界面要显示"这段是什么画面"时直接读它，**白送**。

### 4.3 提示词要求

- **每句话是一个完整的、可独立配画面的自然句。**
- **软目标：每句约 5 秒（约 25 字）。** 这是**写作指导，不是渲染约束**——理由是短视频本来就该这么写，且素材物理长度一般是 5 秒，句子太长会导致下一张图提前顶上。渲染层不设任何上限。
- 明确告知模型：**你没被选中的图会成为备用素材**，所以选图要有取舍，不要为了用满而硬凑。
- 每张选中的图必须给 `rationale`；每张丢弃的图必须给 `reason`。

## 5. 第 3 步改动清单

- `lib/script-providers/types.ts` — `ScriptGenerationInput` 增加 `targetDurationSec: number` 和 `shotImages: Array<{shotId, imageAssetId, mimeType, dataBase64}>`；`duration: string` 删除。输出类型改为 §4.2 的形状。
- `lib/script-providers/openai-compatible.ts` — `chatCompletion` 支持 image parts（复用 `describeImageOpenAiCompatible:93-150` 已有的 data-URI 编码路径）；`buildScriptPrompt:236-306` 按 §4.3 重写。
- `lib/script-providers/gemini.ts` — `geminiCall` / `geminiNativeCall` 支持 inlineData image parts（复用 `describeImageGeminiNative:134-183` 已有的 base64 内联路径）。
- `app/api/projects/[id]/script/route.ts` —
  - `handleGenerate:127-270`：加载分镜时一并读出图片文件并编码；不再把 `sourceFilename` 当 description。
  - `validateAndNormalizeScript:274-345`：**删除 1:1 强制**（`301-317`）。改为校验：每个 `segments[].shotId` 必须属于本分镜组且有可用图；`segments` 不得为空；同一 `shotId` 不得重复出现；`droppedShots` + `segments` 的并集应覆盖全部候选分镜（缺失的自动补进 `droppedShots`）。
- 脚本生成界面 — `duration` 输入改为**数字（秒）**。
- `components/ScriptResultView.tsx` — 按新格式展示：每段显示**缩略图 + 句子 + rationale**（这是脚本能看图之后最直接的可视化红利）；单列出 `droppedShots` 及其原因。
- `components/ShotSetPanel.tsx:530,548` — 修正误导文案。

## 6. 第 5 步引擎改动清单

### 6.1 消费计划

`lib/final-video/prepare-draft.ts` 重写核心路径：

1. 读脚本草稿的 `segments[]`（不再 `resolveSourceText` 压成纯文本）。
2. 每个 segment → 一个口播单元（**就是原来的 beat，但不再切窗口、不再有 `groupId`**）。
3. 逐句 TTS，拿真实时长。
4. 每个 segment 的 `shotId` → 解析到该分镜的视频素材（成功且文件存在的 `video_jobs`）。
5. 产出 timeline 输入，交给 `solve-timeline.ts`。

`lib/final-video/solve-timeline.ts` —— **几乎不动**：
- `:119` 去掉 `input.maxClipSeconds`，改为 `Math.min(wanted, clip.clipDurationSec)`。
- 删除 `last_clip_exceeds_max_after_fallback` issue（`:184-186`）。
- `clip_short_borrowed_forward`（`:145`）和末尾定格（`:150-187`）**保持原样**——它们正是铁律 3 和铁律 4。

`lib/final-video/subtitles.ts` —— 去掉按 `groupId` 合并整句的逻辑；一句 = 一条字幕。

### 6.2 计划撞上现实的对账规则

| 情况 | 处理 |
|---|---|
| 计划里的分镜**视频生成失败/未生成** | 从 `droppedShots` 备用池取一张替补 + **红标**"计划中的画面缺失，已用备用图替补"。备用池空了则退化为下一张图提前顶上 + 红标。 |
| 计划里的分镜**图片被重新生成过**（`shots.latestGeneratedImageId` ≠ `segments[].imageAssetId`） | **软提醒**，不硬拦。红字"图 N 已变更，文案可能不匹配"，但允许继续。理由：重生成多数只是画质/构图微调，主体一致，脚本通常仍然有效；硬拦会在最常见的情况下天天误伤。 |
| 分镜组里**多出了**脚本没见过的新分镜 | 忽略，不自动加入。它属于备用池。 |

### 6.3 界面减法（不做重设计）

成片包装表单从 11 个字段减到 6 个——**不是因为去美化它，而是因为那些步骤真的不存在了**：

| 字段 | 去留 |
|---|---|
| 分镜组 / 成片模式 / 口播脚本 / 口播供应商(TTS) / 音色 / 封面标题 / 封面模板 | 保留 |
| **目标时长** | ❌ 删（搬到第 3 步） |
| **口播文本供应商** | ❌ 删（`narration-script.ts` 已死） |
| **图片理解供应商** | ❌ 删（`vision.ts` 已死） |
| **编排供应商** | ❌ 删（`orchestrate.ts` 已死） |

审核编排列表（`ArrangementEditor.tsx` 等）**维持现有丑陋形态**，能用即可。它在 Round 2 被整体替换。

## 7. 删除清单

| 文件/机制 | 理由 |
|---|---|
| `lib/final-video/orchestrate.ts` | AI 编排——顺序已由脚本决定 |
| `lib/final-video/vision.ts` | 识图——脚本已看过图，描述由 `rationale` 提供 |
| `lib/final-video/narration-script.ts` | LLM 重新切句——脚本已经一句一图分好了 |
| beat 窗口切分机制 | 只为 `maxClipSeconds` 而存在 |
| `NarrationBeat.groupId` | 只为把切碎的 beat 拼回整句而存在 |
| `maxClipSeconds` 配置 | 见 §2.2 |
| `clip_visual_descriptions` 表 | `vision.ts` 的缓存，无人读写后作废。**表结构和数据保留不动**（删表没有收益，只有风险），代码里停止读写即可。 |

`lib/final-video/arrangement.ts`（含 `buildFallbackArrangement`）**由实施者在动手时评估**：它现有的职责是"从素材池构造 ArrangementPlan"，而新模型里这个 plan 直接来自脚本。若删空 `orchestrate.ts` 后该文件只剩类型定义，则合并进 `types.ts`；若还有被复用的校验逻辑，则保留。**不要**把它当作 §8 旧脚本的降级路径——那是一个纯粹的数据形状适配，见下。

## 8. 向后兼容

现有 `script_drafts` 是旧格式（无 `version`、有 `shots[]`、无 `segments[]`）。

- **已渲染成功的成片不受影响**——它们是已落地的文件。
- **旧脚本草稿**：`prepare-draft` 检测到无 `version: 2` 时，走一个**纯数据形状适配**——把旧的 `shots[i]` 直接读成 `segments[i]`（`voiceover` → `narration`，`shotId` → 画面，`imageAssetId` 留空表示不做过期检测，`droppedShots` 为空）。结果就是按 `indexNum` 顺序 1:1，与今天的行为一致。界面提示"**旧版脚本，建议重新生成以获得看图文案**"。
- 不写数据迁移脚本。旧草稿要享受新能力，重新生成脚本即可。

## 9. 已知风险

1. **模型要在一次调用里同时做四件事**（看图、选图、排序、写文案），质量可能不如拆分调用。缓解：产品负责人在 Gemini 官网已验证此用法可行；提示词（§4.3）是本方案的命门，需要单独投入时间打磨。
2. **句子写长了会导致下一张图提前顶上。** 这是设计接受的行为（铁律 3），且会自动收敛。但如果模型频繁写出 8 秒以上的长句，观感会变差。缓解：提示词软目标 + `clip_short_borrowed_forward` 红标暴露给用户。
3. **单点依赖 LLM 的选图判断。** 它会替用户扔掉 3-4 张图。**本期不做"手动锁定必用图"的开关**——先让脚本自己选，界面把"用了哪几张、扔了哪几张、为什么"列清楚；等实际用几次发现真的老选错，再加锁定功能。不为尚未发生的问题提前造机关。
4. **目标时长仍是软约束。** 产品负责人已知情且接受（"明确ai出15秒的脚本，但最后出来的是17秒甚至20秒。不过无所谓的，反正我们的素材够多"）。`target_duration_out_of_tolerance` 警告保留。

## 10. 完成门禁

- `npm run lint`
- 全部 `scripts/final-video-*.test.ts` / `.test.mjs` 通过（其中断言 `maxClipSeconds`、`groupId`、beat 窗口的用例需要按新模型重写）
- `node scripts/db-migrations.test.ts`
- `npm run build`
- **端到端人工验证**：用现有"实木软包沙发"项目跑一遍完整流程，确认 ①脚本文案确实在描述图里存在的东西 ②成片画面顺序与脚本一致 ③无黑屏无异常定格。
