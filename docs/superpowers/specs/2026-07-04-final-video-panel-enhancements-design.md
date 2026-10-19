# Design: 成片包装面板增强（分辨率 / 封面标题联动 / 封面模板 / 口播供应商入口）

## Context

`成片包装`（final video packaging）功能已按 `docs/superpowers/plans/2026-07-04-final-video-packaging.md` 实现并验收通过（见该文档末尾的「计划外偏差记录」）。上线后使用中发现四个需要补的点，本设计只覆盖这四点：

1. 画面比例缺一个 3:4（1440×1920）预设。
2. 封面标题应默认取脚本生成的标题，但用户手动改过之后不应被覆盖。
3. 封面需要先内置 3 个可选择模板，字幕先保持默认白字加阴影的单行样式，位置放在画面下方黄金分割线附近。
4. 口播（TTS）配音的 API Key 目前只能改 `.env.local`，没有 UI 入口——这个 app 里图片/脚本/视频三类供应商都已经有统一的 `/settings` 页面 + DB 存储机制，口播应该接入同一套体系而不是自成一路。

用户还提供了一份 `docs/模块化标准整理.xlsx`（后期组的设计规范库：封面样式/字幕样式/画面排版/通用素材/用色标准/音乐素材，均为 WPS 单元格图片，体量远超本次范围）。本轮只从这份表格中参考用户选中的 3 个封面样例，重建为内置封面模板；不做 Excel 图片自动识别、不做模板编辑器、不做复杂花字字幕。为避免遗忘，表格完整能力摘要记录在本文档末尾「未来方向」一节。

---

## 1. 画面比例新增 3:4（1440×1920）

**改动文件：** `components/FinalVideoPanel.tsx`

`RESOLUTIONS` 常量数组新增一项，插在 9:16 和 16:9 之间（保持从最竖到最横的排序）：

```ts
const RESOLUTIONS = [
  { key: '9:16', label: '竖版 1080×1920', width: 1080, height: 1920 },
  { key: '3:4', label: '竖版 3:4 1440×1920', width: 1440, height: 1920 },
  { key: '16:9', label: '横版 1920×1080', width: 1920, height: 1080 },
  { key: '1:1', label: '方形 1080×1080', width: 1080, height: 1080 },
];
```

后端 `lib/final-video/ffmpeg-graph.ts`（`buildRenderArgs`）与 `lib/final-video/cover.ts`（`buildCoverArgs`）已经是 width/height 参数化的纯函数，不需要改代码。1440 和 1920 都是偶数，libx264 不会有奇数宽高的编码限制问题。

**验证：** 手动跑一次 `npm run dev`，选 3:4 提交一个成片任务，确认输出分辨率和封面尺寸正确；不需要新增单测（现有 `final-video-graph.test.ts` 已覆盖任意 width/height 的参数构建逻辑）。

---

## 2. 封面标题跟随脚本标题，直到用户手动修改

**改动文件：** `components/FinalVideoPanel.tsx`

### 行为契约

- 选中分镜组、`loadPreview` 拿到 `preview.draft.title` 后：**只要标题框当前内容不是用户手动改过的**，就用脚本标题填入（含首次选中分镜组时的初始填充）。
- 用户在标题框输入任何和"当前自动填充值"不同的内容，即视为手动修改，此后**无论怎么切换分镜组、脚本草稿怎么重新生成，都不再自动覆盖**。
- 用户把标题框清空（值变成空字符串），视为放弃手动值，重新允许自动填充（下次 `loadPreview` 返回新标题时会填回去）。

### 实现

```ts
const [titleTouched, setTitleTouched] = useState(false);
const lastAutoTitleRef = useRef('');

// coverTitle 的 onChange：
const handleTitleChange = (value: string) => {
  setCoverTitle(value);
  if (value === '') {
    setTitleTouched(false);
  } else if (value !== lastAutoTitleRef.current) {
    setTitleTouched(true);
  }
};

// loadPreview 拿到新 preview 后（用 draft 是否存在判断，不用 title 真值判断——
// 脚本标题本身是空字符串时也要同步成空，不能因为 falsy 就跳过导致标题框留着上一个分镜组的旧值）：
if (!titleTouched && preview?.draft) {
  const newTitle = preview.draft.title ?? '';
  lastAutoTitleRef.current = newTitle;
  setCoverTitle(newTitle);
}
```

`preview` 接口（`app/api/projects/[id]/final-videos/preview/route.ts`）已经返回 `draft.title`，不需要改后端。

### 顺带修复：`react-hooks/set-state-in-effect` lint 错误

当前 `FinalVideoPanel.tsx` 的两个挂载/依赖 effect（第 90、96 行）已经因为直接调用会触发 `setState` 的 `useCallback` 函数而被 ESLint 判为 error（`npm run lint` 目前是红的）。本次要在这个文件里新增标题同步逻辑，如果不顺手修掉，只会再增加违规点。修复方式是照抄这个代码库里 `components/VideoGenerationPanel.tsx` 已验证过、lint 通过的写法——effect 里用内联的 async IIFE + 存活标志（`let active = true`），而不是调用 `useCallback` 包出来的具名函数：

```ts
useEffect(() => {
  let active = true;
  (async () => {
    await Promise.all([loadShotSets(), loadBgm(), loadJobs()]);
  })();
  return () => { active = false; };
}, []);
```

（`loadShotSets`/`loadBgm`/`loadJobs` 内部各自的 `if (active) setX(...)` 判断按 `VideoGenerationPanel.tsx` 的既有写法补上。）

**验证：** `npm run lint` 无 `FinalVideoPanel.tsx` 相关 error；手动跑 `npm run dev`，选分镜组 A 看到标题自动填、手动改标题、切到分镜组 B 确认标题没被覆盖、清空标题框、再切一次分镜组确认重新自动填充。

---

## 3. 封面模板与默认字幕样式

### 3.1 范围

本轮只做“可用版”：

- 成片包装面板新增 `封面模板` 选择。
- 内置 3 个封面模板，参考用户在模板预览页中选中的三个样例：
  - `封面样式-B7`：轻奢，来源图片 `xl/media/image152.png`
  - `封面样式-C5`：简约，来源图片 `xl/media/image40.jpeg`
  - `封面样式-B8`：轻奢，来源图片 `xl/media/image153.png`
- 封面生成时根据脚本标题和脚本内容自动填充标题、卖点或标签。
- 字幕不做模板选择，第一版只做默认白字加阴影/轻描边的单行样式。
- 字幕位置默认放在画面下方黄金分割线附近；字号和位置保留为可调参数，后续用真实样片微调默认值。

明确不做：

- 不做用户自定义模板编辑器。
- 不做 Excel 图片自动识别版式。
- 不做关键词花字、多行字幕、逐词动画、复杂字幕模板。
- 不落地 `画面排版`、`通用素材`、`音乐素材` 的完整模板化引擎。
- 不把选中的 Excel 样例原图当成最终封面直接贴字；样例只作为重建版式的参考。

### 3.2 UI

`components/FinalVideoPanel.tsx` 的包装配置区域新增一个选择项：

```text
封面模板
  - 轻奢封面 01
  - 简约封面 01
  - 轻奢封面 02
```

选择模板后，封面标题输入仍保留，并沿用第 2 节的自动填充/手动修改保护规则。

字幕区域不新增模板选择。界面保留或调整为：

```text
字幕
  [x] 启用字幕
  字号
  字幕位置
```

### 3.3 数据契约

扩展 `PackageConfig.cover`：

```ts
cover: {
  titleText: string;
  titleSize: number;
  titleColor: string;
  introDurationSec: number;
  templateId?: 'luxury-01' | 'minimal-01' | 'luxury-02';
}
```

字幕配置保留现有结构，不新增 `subtitle.templateId`：

```ts
subtitle: {
  enabled: boolean;
  fontSize: number;
  color: '#ffffff';
  strokeColor: '#000000';
  strokeWidth: number;
  marginBottomPct: number;
}
```

如果旧任务没有 `cover.templateId`，默认使用 `minimal-01`，保证向后兼容且行为确定。

### 3.4 模板配置

新增纯配置模块，例如 `lib/final-video/cover-templates.ts`：

```ts
export type CoverTemplateId = 'luxury-01' | 'minimal-01' | 'luxury-02';

export interface CoverTemplate {
  id: CoverTemplateId;
  name: string;
  reference: {
    workbookSheet: '封面样式';
    cell: string;
    sourceImage: string;
  };
  theme: {
    backgroundOverlay?: string;
    accentColor: string;
    titleColor: string;
    bodyColor: string;
  };
  layout: {
    titleBox: { xPct: number; yPct: number; widthPct: number; align: 'left' | 'center' };
    sellingPointsBox?: { xPct: number; yPct: number; widthPct: number; maxItems: number };
    tagBox?: { xPct: number; yPct: number; widthPct: number };
  };
}
```

模板配置只表达“哪些文字放在哪里、用什么色彩和装饰”。具体 drawtext、底图裁切、阴影、描边和装饰条由封面渲染函数解释执行。

### 3.5 封面渲染

现有 `lib/final-video/cover.ts` 已负责生成封面。本轮在它内部或旁边新增模板化入口：

```ts
buildCoverArgs({
  inputImage,
  output,
  width,
  height,
  titleText,
  templateId,
  sellingPoints,
});
```

封面内容来源：

- 主标题：`preview.draft.title` 或用户手动输入的 `coverTitle`。
- 卖点：第一版从脚本内容中取最稳妥的 1-3 条短句；如果没有结构化卖点，就从分镜字幕或口播中截取前几条非空短句。
- 背景：沿用现有成片封面底图策略，优先使用可代表视频内容的画面，不依赖 Excel 样例原图。

实现上优先保证可读性：

- 标题过长时自动换行或缩小字号。
- 卖点超过模板容量时截断。
- 所有文本在 9:16 和 3:4 下优先保证不出框。
- 横版和方形若模板不适配，先复用 `minimal-01` 的保守居中布局。

### 3.6 字幕渲染

第一版字幕不是模板库，只是明确默认样式：

- 白色文字。
- 黑色阴影或轻描边，保证浅色画面可读。
- 单行字幕。
- 位置在画面下方黄金分割线附近。
- 字号和位置可以从面板调整。

ASS 字幕配置继续由 `lib/final-video/subtitles.ts` 负责。默认值建议：

```ts
subtitle: {
  enabled: true,
  fontSize: 56,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 2,
  marginBottomPct: 18
}
```

`marginBottomPct` 的精确默认值需要实现阶段用真实 9:16、3:4 样片校准；本设计只规定它应接近画面下方黄金分割线，而不是贴近底边。

### 3.7 容错

- 如果传入未知 `templateId`，回退到 `minimal-01`，并写入日志。
- 如果标题为空，封面模板仍生成背景和装饰，不强行显示占位文字。
- 如果卖点为空，只显示标题。
- 如果某个模板文本布局计算失败，任务应失败并记录具体模板 id，避免生成不可读的封面。

### 3.8 验证

- 增加或扩展 cover 参数构建测试，确认 3 个 `templateId` 都能生成 ffmpeg 参数。
- 增加 subtitle 默认值测试，确认默认字幕位置不再使用贴底样式。
- 手动生成成片任务，分别选择 `轻奢封面 01`、`简约封面 01`、`轻奢封面 02`。
- 确认封面标题来自脚本标题，且手动改标题后封面使用手动标题。
- 检查封面标题、卖点、标签不出框。
- 检查字幕为单行白字，位于画面下方黄金分割线附近。
- 在 9:16 和 3:4 至少各生成一条样片确认可读性。

---

## 4. 口播（TTS）供应商接入 `/settings` 统一体系

**现状：** `lib/final-video/tts.ts` 的 `resolveTtsApiKey()` 直接读 `process.env.QWEN_TTS_API_KEY || process.env.DASHSCOPE_API_KEY`，没有任何 UI 入口。而图片/脚本/视频三类供应商都已经是 `/settings` 页面 + 独立 DB 表 + CRUD 路由的统一模式（密钥存 SQLite，前端只显示"已配置/未配置"）。本次让口播成为第 4 类供应商，架构与既有三类保持一致。

### 4.1 新表 `narration_providers`

在 `lib/db.ts` 主 `db.exec` 模板里、`script_providers` 表之后追加（比 `script_providers` 精简——qwen-tts 没有可配置的 baseUrl/model，端点和模型名是固定的）：

```sql
CREATE TABLE IF NOT EXISTS narration_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'qwen-tts',
  apiKey TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  isBuiltin INTEGER NOT NULL DEFAULT 1
);
```

### 4.2 新模块 `lib/narration-providers/`

仿照 `lib/script-providers/{types,config,store}.ts` 三件套：

- **`types.ts`**：`NarrationProviderConfig`（内置默认值：id/name/type）、`NarrationProviderMeta`（返回给前端：id/name/type/category:'narration'/enabled/configured/hasApiKey/missing）。
- **`config.ts`**：`defaultNarrationProviderConfigs = [{ id: 'qwen-tts', name: 'Qwen TTS（阿里云 DashScope）', type: 'qwen-tts' }]`；`resolveNarrationProviderRuntimeConfig(defaults, dbRow)` 计算 `hasApiKey`/`missing`（只会是 `['API Key']`）/`configured = enabled && hasApiKey`。
- **`store.ts`**：`getNarrationProviderRows()`（先 seed 再查全部）、`listNarrationProviderMeta()`、`resolveActiveNarrationProvider()`——在 `enabled=1 且 configured` 的行里取第一条，排序 `ORDER BY isBuiltin DESC, rowid ASC`（内置的 qwen-tts 优先，其余按创建顺序），确保多条都配置时行为确定；供 `tts.ts` 调用。没有任何一条 configured 时返回 `null`。

### 4.3 seed

`lib/seed.ts` 新增 `seedNarrationProviders()`（仿 `seedScriptProviders`，`INSERT ... ON CONFLICT(id) DO UPDATE`，只写入内置的 `qwen-tts` 一行），在 `store.ts` 的查询函数里调用，和 script provider 的调用方式一致。

### 4.4 REST 路由

- `app/api/providers/narration/route.ts` — `GET`（`listNarrationProviderMeta()`）/ `POST`（新增自定义供应商，`isBuiltin=0`）。
- `app/api/providers/narration/[id]/route.ts` — `PUT`（更新 name/type/apiKey/enabled，对应 4.5 表单里的四个字段）/ `DELETE`（`isBuiltin` 的行拒绝删除，返回"内置口播供应商不能删除，可以禁用"）。

结构与 `app/api/providers/script/route.ts`、`[id]/route.ts` 基本一致，直接照抄改表名。

### 4.5 Settings 页面（`app/settings/page.tsx`）

- `type Category = 'image' | 'script' | 'video' | 'narration';`
- 新增 `NarrationProvider` 接口（id/name/category/type/enabled/configured/hasApiKey/missing）。
- `sections` 数组追加：`{ id: 'narration', title: '口播配音', description: 'AI 配音 (TTS) 供应商', icon: 'mic' }`。
- `loadAll()` 并行请求里加 `fetch('/api/providers/narration')`。
- `beginCreate`/`beginEdit`/`buildPayload`/`currentProviders` 的三路分支（image/script/video）改成四路，narration 分支只处理 `name`/`apiKey`/`enabled`。
- `ProviderForm`：narration 分类只渲染 名称、接口类型（下拉，目前只有一个 "qwen-tts" 选项，为未来多供应商留口子）、API Key、启用 四个字段，跳过 baseUrl/model/apiStyle/成本/token/时长这些图片脚本视频专属字段。

### 4.6 图标

`components/ui/Icon.tsx` 的 `IconName` 联合类型里没有话筒/音频类图标，新增一个 `"mic"`，与现有图标集同风格（24×24 viewBox、line-stroke）：

```tsx
mic: (<><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></>),
```

### 4.7 `lib/final-video/tts.ts` 改造

`resolveTtsApiKey()` 整个替换为调用 `resolveActiveNarrationProvider()`；找不到 configured 的供应商时抛出 `未配置口播 API Key：请前往「设置」→「口播配音」配置`（而不是提示改 `.env.local`）。`app/api/projects/[id]/final-videos/route.ts` 里 `mode === 'tts'` 的校验同步改成查这个函数而不是 `resolveTtsApiKey()` 判空。

### 4.8 行为变化（需要告知用户，非 bug）

`QWEN_TTS_API_KEY` / `DASHSCOPE_API_KEY` 环境变量今后不再被读取——和 script/image/video 供应商现在的行为一致（DB 是唯一权威来源，`.env.local` 只在文档里提"曾经支持"）。这台机器目前没有配置这两个环境变量，所以不存在"迁移丢失已有配置"的问题；如果其他环境已经配了，需要在 Settings 里重新填一次。

### 4.9 测试

这类简单 CRUD 路由在这个代码库里一贯是手动 curl 验证（`script`/`video` 供应商路由都没有专门的单测文件），本次照旧：

```bash
curl -s http://localhost:3000/api/providers/narration                     # 看到内置 qwen-tts 一行，hasApiKey:false
curl -s -X PUT http://localhost:3000/api/providers/narration/<id> \
  -H 'Content-Type: application/json' -d '{"apiKey":"sk-xxx"}'            # configured:true
```

新增/改动 `lib/db.ts` 的建表语句后跑一次 `node scripts/db-migrations.test.ts` 确认 SQL 语法没错。

---

## 未来方向（超出本轮范围，供后续立项参考）

`docs/模块化标准整理.xlsx` 是后期组的设计规范库（WPS 单元格图片，约 111MB），六个 sheet：

| Sheet | 内容 |
|---|---|
| 用色标准 | 风格（现代/中古/原木）→ 配色 的映射 |
| 封面样式 | 轻奢/简约/童趣 三种风格的完整封面海报模板（标题+标签+卖点条+品牌角标，叠加在实拍图上）；本轮只选 3 个样例重建为内置模板 |
| 字幕样式 | 色块/简约/轻奢/元素 四种"花字"处理（双行：色块关键词 + 加粗大字）；本轮暂不做字幕模板库，只保留白字阴影单行字幕 |
| 画面排版 | 按单屏/双屏/三屏/四屏拼图数量分类的图文拼版模板（标题+多张产品图+副标语） |
| 通用素材 | 按沙发/实木/板木/睡眠/儿童分类的材质讲解信息图（如海绵结构剖面图+雷达图） |
| 音乐素材 | 5 种情绪分类（活泼活力/科技未来/史诗震撼/温馨童趣/慵懒情调），指向 premiumbeat 音乐库路径 |

这个体量意味着"完整落地"要做一个模板化的图文合成引擎（分层标题/标签/卖点条/品牌角标/多图拼版的图像合成能力），比现在"拼接+单行 drawtext+ASS 字幕+BGM"的成片包装大得多。本轮只做 3 个封面内置模板和默认字幕样式；将来单独立项时可以从"用色标准 + 音乐情绪分类"这类轻量映射开始，逐步过渡到封面/字幕/版式的完整模板渲染。
