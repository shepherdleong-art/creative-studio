# 口播配音：已知模型音色改为勾选，而非手填 —— 设计文档

日期：2026-07-05

## 背景与动机

「设置」→「口播配音」里，供应商类型为 `openai-compatible-tts`（通用 OpenAI 兼容协议）时，「可选音色」一直是自由文本框：用户需要手动输入逗号分隔的音色名（如 `Cherry,Serena,Ethan,Chelsie`）。这是有意为之的设计——`openai-compatible-tts` 只是一种传输协议，Base URL 背后可能是任意模型，代码不能假设任何一套「OpenAI 官方音色名」，否则会在用户接入非 OpenAI 官方后端时产生「看似已配置、实际音色不存在」的静默故障（见 `lib/narration-providers/config.ts` 现有注释）。

但实际场景中，用户经常是通过第三方中转（如 api.v3.cm、api.gpt.ge）以 OpenAI 兼容协议调用一个**具体已知**的模型——最常见的是阿里云通义千问的 `qwen3-tts-flash`。这个模型的音色列表是官方公开、固定的，只是"协议类型"本身不能预判"背后模型是谁"。一旦用户在「模型名」里明确填了 `qwen3-tts-flash`，音色就不再是未知的了，此时继续要求手填音色纯粹是不必要的负担，还容易输错导致合成失败。

本设计的目标：当「模型名」命中一个已知模型时，「可选音色」从自由文本切换为勾选列表，用户直接选、不用打字；模型名对不上已知列表时，保持现状（自由文本）。

## 非目标（Out of scope）

- 不新增供应商 `type` 值，不改 `lib/final-video/tts.ts` 的合成分发逻辑、不改 `lib/narration-providers/config.ts` 的校验逻辑、不改数据库 schema。协议判断依旧只有 `qwen-tts`（原生 DashScope）与 `openai-compatible-tts`（通用协议）两种，`qwen3-tts-flash` 只是后者之下的一个「已知模型」。
- 不做「实时连接第三方中转、探测其真实支持哪些音色」这类校验——中转是否真的把官方全部音色都对接了，属于用户自己核实的范畴，本设计只负责减少手填、不负责验证中转的实际能力。
- 不新增音色分组 / 搜索 UI。48 个音色用一个紧凑网格铺开即可（用户已确认此方案），不做方言/性别等分类。
- 不改动 `components/FinalVideoPanel.tsx` 的音色下拉框——它已经直接读 `provider.voices` 数组渲染 `<select>`，本设计只改变这个数组是「怎么被生产出来的」（勾选 vs 手打），下游消费方式不变。

## 设计

### 1. 已知音色目录（新文件）

新增 `lib/narration-providers/voice-catalog.ts`，按**模型名**索引（不是按供应商 `type`，因为音色由具体模型决定，和走原生 DashScope 还是走 OpenAI 兼容中转无关）：

```ts
export interface KnownVoice {
  /** 传给 API 的 voice 参数值，如 "Cherry" */
  id: string;
  /** 官方中文音色名，用于 checkbox 显示，如 "芊悦" */
  label: string;
  /** 官方人设描述，用于 hover tooltip */
  description: string;
}

/** 按模型名索引的已知音色目录。命中的模型在设置表单里用勾选列表代替自由文本。 */
export const KNOWN_VOICE_CATALOG: Record<string, KnownVoice[]> = {
  'qwen-tts': [
    { id: 'Cherry', label: '芊悦', description: '阳光积极、亲切自然小姐姐（女性）' },
    { id: 'Serena', label: '苏瑶', description: '温柔小姐姐（女性）' },
    { id: 'Ethan', label: '晨煦', description: '标准普通话，带部分北方口音。阳光、温暖、活力、朝气（男性）' },
    { id: 'Chelsie', label: '千雪', description: '二次元虚拟女友（女性）' },
  ],
  'qwen3-tts-flash': [
    { id: 'Cherry', label: '芊悦', description: '阳光积极、亲切自然小姐姐（女性）' },
    { id: 'Serena', label: '苏瑶', description: '温柔小姐姐（女性）' },
    { id: 'Ethan', label: '晨煦', description: '标准普通话，带部分北方口音。阳光、温暖、活力、朝气（男性）' },
    { id: 'Chelsie', label: '千雪', description: '二次元虚拟女友（女性）' },
    { id: 'Momo', label: '茉兔', description: '撒娇搞怪，逗你开心（女性）' },
    { id: 'Vivian', label: '十三', description: '拽拽的、可爱的小暴躁（女性）' },
    { id: 'Moon', label: '月白', description: '率性帅气的月白（男性）' },
    { id: 'Maia', label: '四月', description: '知性与温柔的碰撞（女性）' },
    { id: 'Kai', label: '凯', description: '耳朵的一场SPA（男性）' },
    { id: 'Nofish', label: '不吃鱼', description: '不会翘舌音的设计师（男性）' },
    { id: 'Bella', label: '萌宝', description: '喝酒不打醉拳的小萝莉（女性）' },
    { id: 'Jennifer', label: '詹妮弗', description: '品牌级、电影质感般美语女声（女性）' },
    { id: 'Ryan', label: '甜茶', description: '节奏拉满，戏感炸裂，真实与张力共舞（男性）' },
    { id: 'Katerina', label: '卡捷琳娜', description: '御姐音色，韵律回味十足（女性）' },
    { id: 'Aiden', label: '艾登', description: '精通厨艺的美语大男孩（男性）' },
    { id: 'Eldric Sage', label: '沧明子', description: '沉稳睿智的老者，沧桑如松却心明如镜（男性）' },
    { id: 'Mia', label: '乖小妹', description: '温顺如春水，乖巧如初雪（女性）' },
    { id: 'Mochi', label: '沙小弥', description: '聪明伶俐的小大人，童真未泯却早慧如禅（男性）' },
    { id: 'Bellona', label: '燕铮莺', description: '声音洪亮，吐字清晰，人物鲜活，听得人热血沸腾；金戈铁马入梦来，字正腔圆间尽显千面人声的江湖（女性）' },
    { id: 'Vincent', label: '田叔', description: '一口独特的沙哑烟嗓，一开口便道尽了千军万马与江湖豪情（男性）' },
    { id: 'Bunny', label: '萌小姬', description: '"萌属性"爆棚的小萝莉（女性）' },
    { id: 'Neil', label: '阿闻', description: '平直的基线语调，字正腔圆的咬字发音，这就是最专业的新闻主持人（男性）' },
    { id: 'Elias', label: '墨讲师', description: '既保持学科严谨性，又通过叙事技巧将复杂知识转化为可消化的认知模块（女性）' },
    { id: 'Arthur', label: '徐大爷', description: '被岁月和旱烟浸泡过的质朴嗓音，不疾不徐地摇开了满村的奇闻异事（男性）' },
    { id: 'Nini', label: '邻家妹妹', description: '糯米糍一样又软又黏的嗓音，那一声声拉长了的"哥哥"，甜得能把人的骨头都叫酥了（女性）' },
    { id: 'Seren', label: '小婉', description: '温和舒缓的声线，助你更快地进入睡眠，晚安，好梦（女性）' },
    { id: 'Pip', label: '顽屁小孩', description: '调皮捣蛋却充满童真的他来了，这是你记忆中的小新吗（男性）' },
    { id: 'Stella', label: '少女阿月', description: '平时是甜到发腻的迷糊少女音，但在喊出"代表月亮消灭你"时，瞬间充满不容置疑的爱与正义（女性）' },
    { id: 'Bodega', label: '博德加', description: '热情的西班牙大叔（男性）' },
    { id: 'Sonrisa', label: '索尼莎', description: '热情开朗的拉美大姐（女性）' },
    { id: 'Alek', label: '阿列克', description: '一开口，是战斗民族的冷，也是毛呢大衣下的暖（男性）' },
    { id: 'Dolce', label: '多尔切', description: '慵懒的意大利大叔（男性）' },
    { id: 'Sohee', label: '素熙', description: '温柔开朗，情绪丰富的韩国欧尼（女性）' },
    { id: 'Ono Anna', label: '小野杏', description: '鬼灵精怪的青梅竹马（女性）' },
    { id: 'Lenn', label: '莱恩', description: '理性是底色，叛逆藏在细节里——穿西装也听后朋克的德国青年（男性）' },
    { id: 'Emilien', label: '埃米尔安', description: '浪漫的法国大哥哥（男性）' },
    { id: 'Andre', label: '安德雷', description: '声音磁性，自然舒服、沉稳男生（男性）' },
    { id: 'Radio Gol', label: '拉迪奥·戈尔', description: '足球诗人Rádio Gol！今天我要用名字为你们解说足球（男性）' },
    { id: 'Jada', label: '上海-阿珍', description: '风风火火的沪上阿姐（女性，上海话）' },
    { id: 'Dylan', label: '北京-晓东', description: '北京胡同里长大的少年（男性，北京话）' },
    { id: 'Li', label: '南京-老李', description: '耐心的瑜伽老师（男性，南京话）' },
    { id: 'Marcus', label: '陕西-秦川', description: '面宽话短，心实声沉——老陕的味道（男性，陕西话）' },
    { id: 'Roy', label: '闽南-阿杰', description: '诙谐直爽、市井活泼的台湾哥仔形象（男性，闽南语）' },
    { id: 'Peter', label: '天津-李彼得', description: '天津相声，专业捧哏（男性，天津话）' },
    { id: 'Sunny', label: '四川-晴儿', description: '甜到你心里的川妹子（女性，四川话）' },
    { id: 'Eric', label: '四川-程川', description: '一个跳脱市井的四川成都男子（男性，四川话）' },
    { id: 'Rocky', label: '粤语-阿强', description: '幽默风趣的阿强，在线陪聊（男性，粤语）' },
    { id: 'Kiki', label: '粤语-阿清', description: '甜美的港妹闺蜜（女性，粤语）' },
  ],
};
```

数据来源：阿里云百炼官方文档「Qwen-TTS 非实时语音合成音色列表」（用户从控制台核实并提供），只收录该表中标注支持 `qwen3-tts-flash`（含其带日期的版本号）的音色——即整张非实时表的全部 48 个音色。**没有**混入「实时语音合成」表（`qwen3-tts-flash-realtime` 等 WebSocket 模型）的音色，因为本项目的 openai-compatible 合成走的是 HTTP `POST /v1/audio/speech`（`lib/final-video/tts.ts` 的 `openaiSpeechUrl`），对应官方文档里的"非实时"接口。

#### 辅助函数（同文件导出）

`voice-catalog.ts` 除了 `KNOWN_VOICE_CATALOG` 数据本身，还导出三个纯函数，供 `ProviderForm` 和测试共用——项目没有组件级测试基础设施，所以判断逻辑必须能脱离 React 单独调用/单独测试，不能写成组件内联闭包：

```ts
/**
 * 解析模型名对应的已知音色目录：trim + 大小写不敏感精确匹配；
 * qwen3-tts-flash 的带日期版本号（如 qwen3-tts-flash-2025-11-27）归一到同一目录。
 * 未命中返回 null。
 */
export function resolveKnownVoiceCatalog(model: string): KnownVoice[] | null;

/**
 * 切换一个音色的勾选状态，返回新的逗号分隔字符串。
 * 已知音色按 catalog 原始顺序排在前面；currentVoicesCsv 里已存在但不在 catalog 中的
 * "目录外音色" 原样保留、按其原有相对顺序追加在后，不会因为这次切换被丢弃。
 */
export function toggleVoiceSelection(currentVoicesCsv: string, catalog: KnownVoice[], toggledId: string): string;

/**
 * 仅当 mode === 'create' 且 currentVoicesCsv 为空时，返回 catalog 前 4 个音色 id 作为默认勾选建议；
 * 其余情况（编辑模式，或音色框已有内容——包括"用户曾经填过又清空"这种为空但非首次的场景）一律返回 null，
 * 调用方收到 null 就什么都不做，绝不主动补默认值。
 */
export function resolveDefaultVoiceSelection(
  mode: 'create' | 'edit',
  catalog: KnownVoice[],
  currentVoicesCsv: string
): string[] | null;
```

### 2. `ProviderForm` 的「可选音色」字段行为

`app/settings/page.tsx` 的 `ProviderForm` 组件里，「可选音色」从单一的自由文本框，变成条件渲染：

- `ProviderForm` 需要新增一个显式入参 `mode: 'create' | 'edit'`。父组件在 `beginCreate` 分支传 `create`，在 `beginEdit` 分支传 `edit`。这个入参只用于给 `resolveDefaultVoiceSelection` 判断是否允许默认勾选，避免编辑已有供应商时因为 `voices` 恰好为空而自动写入默认音色。
- **触发条件**：`form.type === 'openai-compatible-tts'` **且** `resolveKnownVoiceCatalog(form.model)` 返回非 `null`。两个条件缺一不可——原生 `qwen-tts` 类型下「模型名」输入框本身是隐藏的（该类型运行时调用的模型是写死的字面量，见 `lib/final-video/tts.ts` 的 `synthesizeQwen`，不读 `rt.model`），`form.model` 可能残留任意历史值，不能单靠模型名判断，否则会在原生 qwen-tts 类型下产生误判。加上类型限定后，原生 qwen-tts 类型的现有行为（自由文本 + 切换类型时的音色预填）完全不受影响。
  - 渲染一个 checkbox 网格。每项显示 `voice 参数（中文音色名）`，如 `Cherry（芊悦）`；`title` 属性放完整 `description`，鼠标悬停时由浏览器原生 tooltip 展示，不占版面。
  - 选中状态：把 `form.voices` 按逗号 split/trim 成 `Set<string>`，`voice.id` 在集合里就是勾选。
  - 勾选/取消：调用 `toggleVoiceSelection(form.voices, catalog, voice.id)`，把返回值写回 `form.voices`。存库字段格式完全不变，`narration_providers.voices` 列还是逗号分隔文本，`resolveNarrationProviderRuntimeConfig` 的解析逻辑不用动。
  - `toggleVoiceSelection` 保证目录外音色不丢失（例如中转额外支持的音色，或用户临时验证的自定义 voice id）。UI 在 checkbox 网格下方用一行小字显示 `未识别音色：xxx, yyy`（`form.voices` 里不在 `catalog` 中的部分），提醒这些值会继续保存但不在当前官方目录中。
  - 目录同时收录了 `qwen-tts`（4 个）作为 key，服务的是另一种真实场景：用户在 `openai-compatible-tts` 类型下把「模型名」手填成字面量 `qwen-tts`（某些中转确实按这个名字暴露旧版千问 TTS），这时也应该出 checkbox 而不是文本框。
- **未命中**（类型不是 `openai-compatible-tts`，或模型名不在目录里、或还没填）：保持现状——自由文本输入框，不做任何改动。

`form.type` / `form.model` 变化时实时重新判断走哪个分支；从「命中」切到「未命中」时，`form.voices` 里已有的字符串原样保留在文本框里，用户可以继续手改，不清空。

### 3. 默认勾选

模型名初始为已知值时（目前仅在 `beginCreate` 里 narration 分类默认模型是 `tts-1`，不在目录里，所以新建时默认还是文本框；只有用户手动把模型名改成 `qwen-tts` 或 `qwen3-tts-flash` 才会切换成 checkbox），checkbox 视图首次出现时调用 `resolveDefaultVoiceSelection(mode, catalog, form.voices)`：返回非 `null` 就把结果 join 成逗号分隔字符串写入 `form.voices`（`qwen-tts`：全部 4 个；`qwen3-tts-flash`：`Cherry / Serena / Ethan / Chelsie`），返回 `null` 就什么都不做。

按函数签名，这一行为只在 `mode === 'create'` 且 `form.voices` 为空时才会真正写入内容。编辑已有供应商时（`mode === 'edit'`），直接按已保存的 `voices` 字符串还原勾选状态，不做默认勾选；即使已有供应商的 `voices` 为空，也保持为空，让用户明确点击勾选后再保存。

### 4. 不变的部分

- `lib/final-video/tts.ts`：`synthesizeOne` 的分发逻辑不变，`openai-compatible-tts` 始终请求 `rt.baseUrl` + `rt.model`，`voice` 参数是运行时由 `FinalVideoPanel` 传入的具体音色名，和"设置页用勾选还是手填生成这个音色列表"无关。
- `lib/narration-providers/config.ts`：`resolveNarrationProviderRuntimeConfig` 的音色解析/校验逻辑不变——依旧是"DB 的 `voices` 列非空才算配置完整"，不区分这个值是勾出来的还是手打的。
- 数据库 schema、`app/api/providers/narration/**` 的路由不变——请求体里的 `voices` 依旧是逗号分隔字符串，后端不感知前端用什么控件生成它。
- `components/FinalVideoPanel.tsx` 的音色 `<select>` 不变。

## 测试计划

新增 `scripts/narration-voice-catalog.test.ts`（沿用项目里 `scripts/*.test.ts` + Node 原生 TS 执行的惯例），覆盖 `lib/narration-providers/voice-catalog.ts` 的纯数据/纯函数部分：
- `KNOWN_VOICE_CATALOG['qwen-tts']` 长度为 4，且 4 个 id 与现有 `defaultNarrationProviderConfigs` 里 `qwen-tts` 的 `defaultVoices` 完全一致（防止两处音色定义漂移）。
- `KNOWN_VOICE_CATALOG['qwen3-tts-flash']` 长度为 48，且每个条目的 `id`/`label`/`description` 都是非空字符串，`id` 无重复。
- `resolveKnownVoiceCatalog('qwen3-tts-flash')` 与带日期版本（如 `qwen3-tts-flash-2025xxxx`）都命中 `qwen3-tts-flash` 目录；未知模型返回 `null`。
- `toggleVoiceSelection` 能按目录顺序回写已知音色，同时保留目录外音色并维持其原始相对顺序不丢失。
- `resolveDefaultVoiceSelection` 只在 `mode === 'create'` 且 `currentVoicesCsv` 为空时返回前 4 个音色 id；`mode === 'edit'` 或 `currentVoicesCsv` 非空时一律返回 `null`。

`ProviderForm` 的 checkbox 渲染/勾选交互属于纯前端组件行为，项目目前没有组件级测试基础设施（无 React Testing Library / jsdom 依赖），沿用现状不新增，改为交付前用 `npm run dev` 手动过一遍：新建/编辑 narration 供应商，模型名切换到 `qwen3-tts-flash` 时出现 checkbox 网格且默认勾 4 个、勾选变化正确回写 `voices` 字符串；切到其他模型名时正确退回文本框且不清空已有内容。

## 交付文件清单

- 新增 `lib/narration-providers/voice-catalog.ts`
- 修改 `app/settings/page.tsx`（`ProviderForm` 组件的「可选音色」字段渲染逻辑）
- 新增 `scripts/narration-voice-catalog.test.ts`
