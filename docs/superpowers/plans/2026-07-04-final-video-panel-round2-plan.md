# Plan: 成片包装面板增强（第二轮 · 封面示例图 / 片头改名 / TTS 多供应商 / BGM 目录）

> 交接执行文档。按本文档逐节实现即可，无需再回读需求会话。每节都给了改动文件、数据契约、实现要点与验证步骤。
> 前置：`docs/superpowers/plans/2026-07-04-final-video-packaging.md`（一期实现）、`docs/superpowers/specs/2026-07-04-final-video-panel-enhancements-design.md`（一轮增强，已上线）。

## Context

成片包装（`components/FinalVideoPanel.tsx` + `lib/final-video/*`）一期与一轮增强已上线。使用中发现四个问题，外加梳理出若干附带清理项。本轮范围与三项已确认的取舍：

| # | 问题 | 本轮决策 |
|---|---|---|
| 1 | 封面模板是纯文字下拉，用户靠猜 | 改成**预渲染静态缩略图**的图片卡片选择器 |
| 2 | 「片头贴片」命名误导、和封面脱节 | 它其实就是"把封面当静帧停在片头 N 秒"——**改名 + 归组到封面** |
| 3 | 口播 TTS 写死阿里云 DashScope | 把口播供应商做成真正 adapter，**本轮先加 `openai-compatible-tts` 一类**（覆盖 api.gpt.ge 等），保留内置 qwen-tts |
| 4 | BGM 没有可见目录/上传藏得深 | **显示受管目录路径 + 上传按钮化 + 刷新列表** |

附带清理见 §5。

### 当前事实（实现前已核对）

- `narration_providers` 表当前列：`id/name/type/apiKey/enabled/isBuiltin`，**无 baseUrl/model**（`lib/db.ts:253`）。
- `lib/final-video/tts.ts`：URL 与 `model:'qwen-tts'` 全硬编码（第 13、28 行）；`resolveTtsApiKey()` 只取 `apiKey`。
- 请求契约 `narration:{mode,voice,speed}`，**无 providerId**；服务端 `resolveActiveNarrationProvider()` 自动挑第一个 configured 供应商——配置多个时有歧义。
- `POST /api/projects/[id]/final-videos` 用 `resolveTtsApiKey()` 判空放行（route.ts:47-54）。
- 面板音色写死 `['Cherry','Serena','Ethan','Chelsie']`（Qwen 专属，FinalVideoPanel.tsx:295）。
- 「片头贴片」= `introSec`→`cover.introDurationSec`；`render-queue.ts:214` `coverJpgPath: intro>0?coverPath:null` 把封面当片头静帧，口播轨在开头补等长静音。
- `GET /api/bgm` **已返回 `dir`**，但面板没用（FinalVideoPanel.tsx:82-85 丢弃了 dir）。BGM 存 `dataRoot()/storage/bgm/`，全局共享。
- `Icon.tsx` 已有 `mic` 图标（第 44 行）。
- `public/` 存在；缩略图放 `public/cover-templates/`。
- `CORE_DB_MIGRATIONS`（`lib/db-migrations.ts`）是扁平 `ALTER TABLE` 列表，每条被 try/catch 包裹，已应用列静默跳过——本轮加列走这里。
- **无** open-folder / shell 端点（grep 无结果）——"打开目录"若做需新端点，本轮列为可选 P2。

### 建议执行顺序

1. §3（TTS 多供应商）— 最大、独立，先做完能单独验收。
2. §1（封面缩略图）— 需要新建预渲染脚本。
3. §2（片头改名）、§4（BGM 目录）、§5（清理）— 纯面板/文案，可合并一次做。

每节可独立提交。

---

## 1. 封面模板 → 预渲染示例图选择器

**目标：** 面板的「封面模板」从 `<select>` 换成可点选的缩略图卡片；每个模板有一张预渲染样例封面。

**改动文件：**
- 新增 `scripts/generate-cover-template-previews.mjs`（可重复运行的预渲染脚本）
- 新增产物 `public/cover-templates/{luxury-01,minimal-01,luxury-02}.jpg`
- `lib/final-video/cover-templates.ts`（给每个模板加 `previewImage` 字段；`TEMPLATE_OPTIONS` 带上 `previewImage` 与 `elements`）
- `components/FinalVideoPanel.tsx`（下拉 → 卡片网格）

### 1.1 预渲染脚本

`buildCoverArgs`（`cover.ts:55`）固定以 `-ss 0.5 -i <sourceVideoPath>` 抽帧作底图，因此脚本先用 ffmpeg lavfi 造一段 1s 渐变视频当底图，再喂给 `buildCoverArgs`，**零改动 `cover.ts`**：

```js
// scripts/generate-cover-template-previews.mjs
// 用法：node scripts/generate-cover-template-previews.mjs
// 依赖 lib/ffmpeg.ts 的 resolveFfmpeg（env → ffmpeg-static → PATH），与渲染同源。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COVER_TEMPLATES } from '../lib/final-video/cover-templates.ts';
import { buildCoverArgs } from '../lib/final-video/cover.ts';
import { resolveFontFile } from '../lib/final-video/subtitles.ts';
import { runFfmpeg } from '../lib/ffmpeg.ts';

const OUT_DIR = path.resolve('public/cover-templates');
const W = 1080, H = 1920;                    // 与竖版一致，保证版式所见即所得
const SAMPLE = { title: '三大亮点一次看完', points: ['亲肤面料透气', '十年质保放心', '环保板材无醛'] };

fs.mkdirSync(OUT_DIR, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-preview-'));
const bg = path.join(tmp, 'bg.mp4');
// 渐变底图（无需外部素材）；换成真实样片时把 -f lavfi 段替换为 -i sample.jpg 即可
await runFfmpeg(['-f','lavfi','-i',`gradients=s=${W}x${H}:c0=0x2b2b3c:c1=0x0b0b14:d=1`,'-t','1','-y',bg], { timeoutMs: 30_000 });

const fontFile = resolveFontFile();
for (const t of Object.values(COVER_TEMPLATES)) {
  const out = path.join(OUT_DIR, `${t.id}.jpg`);
  await runFfmpeg(buildCoverArgs({
    sourceVideoPath: bg, titleText: SAMPLE.title, titleSize: 72, titleColor: '#ffffff',
    width: W, height: H, fontFile, outJpgPath: out, templateId: t.id, sellingPoints: SAMPLE.points,
  }), { timeoutMs: 60_000 });
  console.log('wrote', out);
}
fs.rmSync(tmp, { recursive: true, force: true });
```

> 注：产出的缩略图**提交进仓库**（`public/` 不在 installer 裁剪的 dev-only 目录清单里，随包分发没问题）。将来模板视觉调整后重跑此脚本即可。

### 1.2 模板配置补字段

`lib/final-video/cover-templates.ts`：

```ts
export interface CoverTemplate {
  // ...现有字段
  previewImage: string;          // '/cover-templates/<id>.jpg'
  elements: string[];            // 卡片上标注该模板会渲染哪些元素，如 ['标题','卖点']
}
```

各模板填：
- `luxury-01`: `previewImage:'/cover-templates/luxury-01.jpg'`, `elements:['标题','卖点']`
- `minimal-01`: `previewImage:'/cover-templates/minimal-01.jpg'`, `elements:['标题']`（**注意**：minimal 无 `sellingPointsBox`，卖点不渲染——见 §5-B）
- `luxury-02`: `previewImage:'/cover-templates/luxury-02.jpg'`, `elements:['标题','卖点','标签']`

`TEMPLATE_OPTIONS` 映射带上 `previewImage` 和 `elements`。

### 1.3 面板卡片选择器

`components/FinalVideoPanel.tsx` 把「封面模板」的 `<select>`（第 275-279 行）换成卡片网格。缩略图用 `<img>`（与本文件既有 `eslint-disable @next/next/no-img-element` 惯例一致）：

```tsx
<label className="label">封面模板</label>
<div className="grid grid-cols-3 gap-2">
  {TEMPLATE_OPTIONS.map((t) => (
    <button key={t.id} type="button" onClick={() => setCoverTemplate(t.id)}
      className={`overflow-hidden rounded-lg border text-left ${coverTemplate === t.id ? 'border-accent ring-1 ring-accent' : 'border-hairline'}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={t.previewImage} alt={t.name} className="aspect-[9/16] w-full object-cover" />
      <div className="px-1.5 py-1">
        <p className="truncate text-xs">{t.name}</p>
        <p className="truncate text-[10px] text-ink-tertiary">{t.elements.join(' · ')}</p>
      </div>
    </button>
  ))}
</div>
```

`coverTemplate` state 与提交逻辑不变，只是控件形态从下拉变卡片。

**验证：**
- `node scripts/generate-cover-template-previews.mjs` 生成 3 张图，肉眼确认版式差异（若三者太像，说明模板本身区分度不足——记入 §5 后续）。
- `npm run dev` 看到卡片网格、选中态高亮；选不同模板各提交一次成片，成片封面与所选卡片版式一致。

---

## 2. 「片头贴片」重命名 + 归组到封面

**目标：** 消除命名误导，把它和封面标题/模板放一起。**纯面板改动，数据契约不变**（仍写 `cover.introDurationSec`）。

**改动文件：** `components/FinalVideoPanel.tsx`

- Label「片头贴片」→「**封面片头停留**」；加副说明 `<p className="text-[10px] text-ink-tertiary">在正片前把封面作为静帧停留 N 秒</p>`。
- 选项保留 `无 / 1 秒 / 2 秒`，可加 `3 秒`。
- **布局归组**：当前 `grid grid-cols-2` 里，把「封面标题」「封面模板」「封面片头停留」三项收进同一视觉分组（用一个带小标题 `封面 / 片头` 的 `<div className="rounded-md border border-hairline p-3">` 包起来），与「口播配音」「BGM」「字幕」区分开。

**验证：** UI 文案与分组正确；`封面片头停留=2秒` 时成片开头有 2s 封面静帧、`无` 时无；口播开头静音时长随之匹配（回归 §3 的 TTS 路径）。

---

## 3. 口播 TTS 接入 OpenAI 兼容供应商（多 adapter）

**目标：** 口播供应商从"只 qwen-tts"扩成真正 adapter，本轮新增 `openai-compatible-tts`（POST `{baseUrl}/v1/audio/speech`）。面板可选供应商、音色随供应商联动。

> 参照系：`lib/script-providers/{types,config,store}.ts` 已是"内置多条 + baseUrl/model + configured/missing"的成熟形态，本节照抄其结构。

### 3.1 DB 迁移（加 baseUrl / model 列）

- `lib/db.ts:253` 建表模板补两列（新装库直接带列）：
  ```sql
  baseUrl TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  ```
- `lib/db-migrations.ts` 的 `CORE_DB_MIGRATIONS` 末尾追加（老库升级；框架已 try/catch）：
  ```js
  `ALTER TABLE narration_providers ADD COLUMN baseUrl TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE narration_providers ADD COLUMN model TEXT NOT NULL DEFAULT ''`,
  ```

### 3.2 config / types 扩展（`lib/narration-providers/`）

**types.ts** — `NarrationProviderConfig` 加可选 `defaultBaseUrl?/defaultModel?/voices?`；`NarrationProviderMeta` 加 `baseUrl/model/voices`。

**config.ts**：
- `NarrationProviderDbRow` 加 `baseUrl:string; model:string`。
- `NarrationProviderRuntimeConfig` 加 `baseUrl/model/voices`。
- `defaultNarrationProviderConfigs` 加第二条内置项：
  ```ts
  export const NARRATION_VOICES: Record<string, string[]> = {
    'qwen-tts': ['Cherry', 'Serena', 'Ethan', 'Chelsie'],
    'openai-compatible-tts': ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
  };
  export const defaultNarrationProviderConfigs = [
    { id: 'qwen-tts', name: 'Qwen TTS（阿里云 DashScope）', type: 'qwen-tts',
      defaultBaseUrl: '', defaultModel: 'qwen-tts' },
    { id: 'openai-tts', name: 'OpenAI 兼容 TTS', type: 'openai-compatible-tts',
      defaultBaseUrl: '', defaultModel: 'tts-1' },   // 用户填 baseUrl，如 https://api.gpt.ge
  ];
  ```
- `resolveNarrationProviderRuntimeConfig`：按 `type` 计算 `missing`——
  - `qwen-tts`：缺 `API Key`。
  - `openai-compatible-tts`：`API Key` / `Base URL` / `模型` 缺哪个报哪个。
  - `configured = enabled && missing.length === 0`。
  - `voices = NARRATION_VOICES[type] ?? []`。

**store.ts**：
- `listNarrationProviderMeta()` 带上 `baseUrl/model/voices`。
- 新增 `resolveNarrationProvider(providerId?: string)`：给了 `providerId` 就解析该行（enabled+configured 才返回，否则抛错说明是哪个供应商没配好）；没给则退回现有 `resolveActiveNarrationProvider()`（`ORDER BY isBuiltin DESC, rowid ASC` 取第一条 configured）。返回**整个 runtime**（含 type/baseUrl/model/apiKey），供 tts.ts 分流。

### 3.3 seed（`lib/seed.ts`）

`seedNarrationProviders()` 的 INSERT 补 `baseUrl/model` 列，遍历两条 defaults 写入 `defaultBaseUrl/defaultModel`。**`ON CONFLICT(id) DO UPDATE` 保持只更新 `name/type/isBuiltin`**（不覆盖用户填的 apiKey/baseUrl/model）：

```ts
const insert = db.prepare(`
  INSERT INTO narration_providers (id, name, type, apiKey, baseUrl, model, enabled, isBuiltin)
  VALUES (?, ?, ?, '', ?, ?, 1, 1)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, isBuiltin = 1
`);
for (const c of defaultNarrationProviderConfigs) insert.run(c.id, c.name, c.type, c.defaultBaseUrl ?? '', c.defaultModel ?? '');
```

### 3.4 REST 路由

- `app/api/providers/narration/route.ts` POST：INSERT 加 `baseUrl/model` 两列，从 body 取（默认空 / `body.model`）。
- `app/api/providers/narration/[id]/route.ts` PUT：白名单 `['name','type']` → `['name','type','baseUrl','model']`（`apiKey`/`enabled` 已单独处理）。

### 3.5 tts.ts adapter 化

`lib/final-video/tts.ts` 核心改动——按供应商 type 分流合成，OpenAI 路径响应体直接是音频二进制、原生支持 speed：

```ts
// 规范化 OpenAI 兼容端点：baseUrl 可能已含 /v1
function openaiSpeechUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(b) ? `${b}/audio/speech` : `${b}/v1/audio/speech`;
}

// resolveTtsApiKey → 保留为薄封装（route.ts 兼容），内部调 resolveNarrationProvider
export async function resolveNarrationRuntime(providerId?: string) {
  const { resolveNarrationProvider } = await import('@/lib/narration-providers/store');
  const p = resolveNarrationProvider(providerId);
  if (!p) throw new Error('未配置口播供应商：请前往「设置」→「口播配音」配置');
  return p; // { type, apiKey, baseUrl, model, ... }
}

// synthesizeOne 按 type 分流，返回 { buffer, speedApplied }
async function synthesizeOne(text, voice, speed, rt): Promise<{ buffer: Buffer; speedApplied: boolean }> {
  if (rt.type === 'openai-compatible-tts') {
    const resp = await fetch(openaiSpeechUrl(rt.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${rt.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: rt.model || 'tts-1', input: text, voice, response_format: 'mp3', speed }),
    });
    if (!resp.ok) throw new Error(`openai-tts HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return { buffer: Buffer.from(await resp.arrayBuffer()), speedApplied: true }; // OpenAI 原生 speed，跳过 atempo
  }
  // qwen-tts：现有 DashScope 流程（POST → output.audio.url → 下载）
  // ...返回 { buffer, speedApplied: false }（qwen 无 speed 参数，继续本地 atempo）
}
```

`synthesizeNarrationSegments`：新增 `providerId` 入参 → 开头 `const rt = await resolveNarrationRuntime(providerId)`；循环内调 `synthesizeOne(text, voice, speed, rt)`，`atempo` 仅在 `!speedApplied && |speed-1|>0.01` 时加。`buildNarrationTrack` 不变（输入仍是统一 m4a）。

### 3.6 请求契约 + queue + route

- `types.ts` `NarrationConfig` 加 `providerId?: string`；`defaultPackageConfig()` 里 narration 加 `providerId: ''`（`mergePackageConfig` 已对象级合并，无需额外处理）。
- `render-queue.ts:134` 调用 `synthesizeNarrationSegments` 时透传 `providerId: pkg.narration.providerId`。
- `route.ts:47-54` 校验改为 `await resolveNarrationRuntime(pkg.narration.providerId)`（configured 才放行；错误信息直接透出）。

### 3.7 Settings 页面（`app/settings/page.tsx`）

- 接口类型下拉 narration 分支（第 483-487 行）加：`<option value="openai-compatible-tts">OpenAI 兼容 TTS</option>`。
- baseUrl 字段（第 500 行 `category !== 'narration'` 门控）→ 改为 `category !== 'narration' || form.type === 'openai-compatible-tts'`；model 字段（第 506 行）同样放开。
- `buildPayload` narration 分支（第 233-238 行）带上 `baseUrl/model`。
- `beginCreate`/`beginEdit` 初始化 narration 表单时带 `baseUrl/model`（openai 类默认 `model:'tts-1'`）。
- `ProviderCard` 的 model 显示（第 393、417 行）：narration 且 openai 类时也显示 model。

### 3.8 面板供应商 + 音色联动（`components/FinalVideoPanel.tsx`）

- 挂载时 `fetch('/api/providers/narration')`，存 `narrationProviders`（只保留 `configured` 的）。
- 新增 state `narrationProviderId`，默认取第一个 configured 供应商 id。
- 「口播配音」区当 `mode==='tts'`：
  - 若 configured 供应商 >1，显示供应商下拉（选择 `narrationProviderId`）；仅 1 个则自动选中、不显示下拉。
  - **音色下拉用所选供应商 meta 的 `voices`**（取代写死的 `['Cherry',...]`）；切换供应商时若当前 voice 不在新列表则回退到列表首项。
  - 若无任何 configured 供应商，禁用「AI 配音」并提示"请先在设置→口播配音配置"。
- 提交时 `narration: { mode, voice, speed, providerId: narrationProviderId }`。

### 3.9 验证

- `node scripts/db-migrations.test.ts` 确认加列 SQL 语法无误。
- CRUD（照 script/video 供应商惯例手动 curl）：
  ```bash
  curl -s localhost:3000/api/providers/narration                      # 两条内置：qwen-tts、openai-tts，hasApiKey:false
  curl -s -X PUT localhost:3000/api/providers/narration/openai-tts \
    -H 'Content-Type: application/json' \
    -d '{"apiKey":"sk-xxx","baseUrl":"https://api.gpt.ge","model":"tts-1"}'   # configured:true
  ```
- 手动：分别用 qwen-tts 与 openai 兼容（api.gpt.ge）各出一条带口播的成片，确认音色、语速正确、开头静音对齐；未配置时「AI 配音」禁用并提示。

---

## 4. BGM 目录可见 + 上传改进

**目标：** 回答"BGM 目录在哪"——把受管目录路径显示出来，上传按钮化，加刷新。

**改动文件：** `components/FinalVideoPanel.tsx`（`GET /api/bgm` 已返回 `dir`，后端无需改）

- `loadBgm` / 挂载加载时保存 `data.dir` 到新 state `bgmDir`（当前第 84、108 行只取了 `data.bgm`，丢了 `dir`）。
- BGM 区展示：
  - 一行小字 `BGM 目录：{bgmDir}` + 「复制」按钮（`navigator.clipboard.writeText`）+ 一句"全局共享，所有项目可用"。
  - 上传：把裸 `<input type="file">`（第 309 行）包进 `<label className="btn-secondary btn-sm">上传 BGM<input hidden .../></label>`。
  - 加「刷新列表」按钮 → `loadBgm()`（用户手动往目录丢文件后可刷出来）。

**验证：** 面板显示真实 `storage/bgm` 绝对路径；上传按钮可用、上传后自动出现在下拉；手动往目录放一个 mp3 后点刷新能看到；复制按钮把路径写入剪贴板。

> 可选（P2，需新端点）："打开目录"按钮。当前无 open-folder/shell 端点，需新增 `POST /api/open-folder`（按 `process.platform` 调 `open`/`explorer`/`xdg-open`）。本轮不做，仅显示路径+复制。

---

## 5. 附带清理

| 项 | 改动 | 优先级 |
|---|---|---|
| **A. 封面标题字号** | 面板提交写死 `titleSize:72`（第 189 行）。加一个字号输入（复用 subtitle 字号控件样式）或直接沿用 72——至少把魔法数提到常量。 | P2 |
| **B. 卖点随模板提示** | `minimal-01` 无 `sellingPointsBox`，自动提取的卖点算了不渲染。§1.2 已在卡片用 `elements` 标注"该模板包含 标题/卖点/标签"，用户选 minimal 时能一眼看到不含卖点。**无需额外代码**，随 §1 落地即可。 | 随 §1 |
| **C. TTS 试听** | 设置页 narration 卡片加「试听」：新端点 `POST /api/providers/narration/[id]/preview`，用固定短句（如"你好，这是口播试听"）走 §3.5 的 `synthesizeOne` 返回音频，前端 `<audio>` 播放。大幅缩短"配完不知道对不对"的反馈环。 | P2（推荐） |
| **D. 音色数据化** | 已由 §3.2 的 `NARRATION_VOICES` + `voices` 解决，面板不再写死。 | 随 §3 |
| **E. BGM 全局说明** | §4 已在 BGM 区加"全局共享"说明。 | 随 §4 |

---

## 交付验收清单（全部完成后）

- [ ] 封面模板为缩略图卡片，3 张预览图已提交，选择即所见即所得。
- [ ] 「封面片头停留」文案 + 与封面同组；0/1/2s 行为正确。
- [ ] 口播支持 qwen-tts 与 openai 兼容两类；面板可选供应商、音色随供应商；未配置时禁用并提示。
- [ ] `node scripts/db-migrations.test.ts` 通过；老库升级不丢已有配置。
- [ ] BGM 目录路径可见、上传按钮化、刷新可用。
- [ ] `npm run lint` 无新增错误；`npm run build` 通过。
- [ ] 至少各出一条 9:16 成片：qwen 口播 + BGM + 烧字幕 + 封面片头；openai 口播。

## 明确不做（本轮范围外）

- 不做用户自定义封面模板编辑器、不做 Excel 图片自动版式（见 enhancements-design §未来方向）。
- 不做 Azure/ElevenLabs 等更多 TTS 类型（本轮只 OpenAI 兼容）。
- 不做 BGM"打开目录"端点（仅显示路径+复制）。
- 不做字幕模板库 / 花字 / 多行字幕。

## 计划外偏差记录

实现过程中发现的、与本文档假设不符或本文档未规定实现细节的地方，逐条记录「原计划 → 实际改法 → 原因」。

1. **luxury-02 模板的 `elements` 不含"标签"**
   - 原计划（§1.2）：`luxury-02: elements:['标题','卖点','标签']`。
   - 实际改法：`elements:['标题','卖点']`，去掉"标签"，并在 `cover-templates.ts` 里加注释说明原因。
   - 原因：grep 全仓库确认 `layout.tagBox` 只在 `cover-templates.ts` 里被声明，`cover.ts` 的 `buildCoverArgs` 从未读取/渲染它（该函数只实现了背景遮罩、装饰条、标题、卖点四步，没有第五步渲染标签）。如果卡片仍标注"标签"，用户选择 luxury-02 后会发现封面根本没有标签，正好违背 §1 的初衷（"用户选 minimal 时能一眼看到不含卖点"同理适用于这里）。这是本轮之前就存在的实现缺口（tagBox 从未被实现），不在本轮范围内补齐渲染，只是如实描述现状。

2. **Settings 页"添加供应商"里口播新建默认类型改为 `openai-compatible-tts`**
   - 原计划（§3.7）：未明确要求改默认类型，只说"beginCreate/beginEdit 初始化 narration 表单时带 baseUrl/model（openai 类默认 model:'tts-1'）"。
   - 实际改法：`beginCreate` 对 `category === 'narration'` 时，默认 `type` 由原来的 `'qwen-tts'` 改为 `'openai-compatible-tts'`，默认 `model` 设为 `'tts-1'`。
   - 原因：两个内置供应商（qwen-tts、openai-tts）已经存在，用户点"添加供应商"新建的自定义口播供应商，现实场景里几乎总是"接入另一个 OpenAI 兼容 TTS 端点"（不同 baseUrl/vendor），而不是再建一个 qwen-tts。若不改默认类型，plan 括号里"openai 类默认 model:'tts-1'"这句话在默认路径下永远不会触发（因为默认 type 仍是 qwen-tts，baseUrl/model 字段仍隐藏）。改成这样让该行为在最常见路径下就能体现。

3. **`resolveTtsApiKey` 保留为无调用方的废弃导出**
   - 原计划（§3.5 注释）：`resolveTtsApiKey → 保留为薄封装（route.ts 兼容）`。
   - 实际改法：函数保留（标 `@deprecated`），但 §3.6 同时要求 `route.ts` 和 `tts.ts` 内部的 `synthesizeNarrationSegments` 都直接改调 `resolveNarrationRuntime`。改完之后 grep 全仓库确认 `resolveTtsApiKey` 已无任何调用方。
   - 原因：计划文本里这两句话本身互相矛盾（一边说保留是为了兼容 route.ts，一边又让 route.ts 改用新函数）。按文档字面要求保留了该函数（未删除，避免破坏"计划要求保留"的意图），但如实记录它现在是死代码，供后续清理参考。

4. **§3.9 curl 示例的 apiKey 值 `sk-xxx` 无法产生 `configured:true`**
   - 原计划（§3.9）：`curl ... -d '{"apiKey":"sk-xxx", ...}'` 后注释 `# configured:true`。
   - 实际验证：原样执行该命令，`configured` 为 `false`，`hasApiKey` 为 `false`，`missing` 含 `"API Key"`。换成 `sk-abcdef1234567890` 后 `configured:true`。
   - 原因：`lib/narration-providers/config.ts` 的 `isReal()`（沿用自 script-providers 的既有逻辑，本轮未改动）会把值里含子串 `xxx`（忽略大小写）判定为占位符而拒绝。`"sk-xxx"` 恰好命中这条规则。这是既有校验逻辑与计划示例文本的不一致，不是本轮代码缺陷；记录下来避免后续有人照抄该 curl 命令得到和注释不符的结果时误以为是 bug。

5. **口播供应商切换时的音色回退，用"渲染期间调整状态"而非 `useEffect`**
   - 原计划（§3.8）：只描述行为"切换供应商时若当前 voice 不在新列表则回退到列表首项"，未规定实现机制。
   - 实际改法：最初按最直觉的方式写成一个 `useEffect`（依赖 `narrationProviderId`/`narrationProviders`，内部直接同步调用 `setVoice`）。`npm run lint` 报错：`react-hooks/set-state-in-effect`（"Calling setState synchronously within an effect can trigger cascading renders"），是本仓库 ESLint 配置里的硬错误而非警告。改为 React 官方文档推荐的"渲染期间调整状态"写法（一个 `voiceSyncedProviderId` 追踪状态 + 渲染体内条件式 `setState`，不经过 effect）。
   - 原因：本文件里其它类似"异步加载后同步一批状态"的 effect（如切换分镜组重新加载预览）都把 `setState` 调用放在 `await fetch(...)` 之后的异步回调里，因此不会被这条 lint 规则命中；只有我最初那个纯同步 effect 会命中。为了不引入新的 lint error、也不去抑制这条规则（该仓库看起来是刻意把它当错误而非警告对待），改用官方推荐的替代写法。

6. **TTS 试听端点（§5-C）把合成结果转码为 AAC/m4a 后再返回，而非直接透传 `synthesizeOne` 的原始字节**
   - 原计划（§5-C）："用固定短句...走 §3.5 的 `synthesizeOne` 返回音频，前端 `<audio>` 播放"，未规定响应编码/Content-Type。
   - 实际改法：`app/api/providers/narration/[id]/preview/route.ts` 拿到 `synthesizeOne` 的原始 buffer 后，复用正式合成流程里已有的 ffmpeg 转码步骤（`-c:a aac -b:a 128k`），统一编码成 `.m4a`，以 `Content-Type: audio/mp4` 返回。
   - 原因：`synthesizeOne` 对不同供应商返回的原始字节格式不保证一致（qwen-tts 走 DashScope 返回的音频 URL，格式未在官方文档里逐字确认；openai-compatible-tts 我们显式请求 `response_format:'mp3'`）。若直接透传原始字节并猜一个 Content-Type，遇到非预期格式时浏览器 `<audio>` 可能无法播放。转码成统一格式是这个代码库已经在用、已被验证过的路径（`synthesizeNarrationSegments`/`buildNarrationTrack` 就是这么做的），复用它比引入新的"猜格式"逻辑更可靠。

7. **`scripts/db-migrations.test.ts` 补充 `narration_providers` 表的迁移断言**
   - 原计划：§3.9 只要求"确认加列 SQL 语法无误"，未要求扩展现有测试文件。
   - 实际改法：给 `scripts/db-migrations.test.ts` 加了一个旧结构的 `narration_providers` 表（无 `baseUrl`/`model` 列）+ 迁移后断言两列已加上、且已有 `apiKey` 数据不丢。
   - 原因：验证时发现这个测试文件本来就没建过 `narration_providers` 表——`providers`/`video_providers`/`script_providers` 三张表都有对应的"旧结构 + 迁移断言"覆盖，唯独 `narration_providers` 一直没有（哪怕它是上一轮就建的表）。本轮既然改了它的迁移语句，顺手把这个覆盖空白补上，比只做一次性手工验证更能防止未来回归。改动范围仍在计划要求"跑通"的同一个文件内，没有新增文件。
