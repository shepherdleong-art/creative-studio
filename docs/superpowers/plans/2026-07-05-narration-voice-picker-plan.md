# 口播配音音色勾选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「设置」→「口播配音」的供应商表单里，当模型名命中一个已知模型（`qwen-tts` 或 `qwen3-tts-flash`）时，「可选音色」从自由文本框变成勾选列表；命不中已知模型时保持自由文本框不变。

**Architecture:** 新增一个纯数据+纯函数模块 `lib/narration-providers/voice-catalog.ts`（已知音色目录 + 3 个可独立测试的辅助函数），`app/settings/page.tsx` 的 `ProviderForm` 组件调用这些函数决定渲染 checkbox 网格还是自由文本框。不新增供应商 `type`、不改后端合成/校验逻辑、不改数据库 schema——`voices` 列的存储格式（逗号分隔字符串）完全不变。

**Tech Stack:** Next.js 16 App Router + React 19 + TypeScript；测试用 Node 22 原生 TS 执行（`node scripts/*.test.ts` + `node:assert/strict`），无组件级测试框架。

**Spec:** `docs/superpowers/specs/2026-07-05-narration-voice-picker-design.md`

---

### Task 1: 已知音色目录 + 纯函数模块

**Files:**
- Create: `lib/narration-providers/voice-catalog.ts`
- Test: `scripts/narration-voice-catalog.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `scripts/narration-voice-catalog.test.ts`：

```ts
import assert from 'node:assert/strict';
import {
  KNOWN_VOICE_CATALOG,
  resolveKnownVoiceCatalog,
  toggleVoiceSelection,
  resolveDefaultVoiceSelection,
} from '../lib/narration-providers/voice-catalog.ts';
import { defaultNarrationProviderConfigs } from '../lib/narration-providers/config.ts';

// KNOWN_VOICE_CATALOG['qwen-tts'] 必须和 defaultNarrationProviderConfigs 里 qwen-tts 的
// defaultVoices 完全一致，防止两处音色定义漂移。
const qwenTtsDefaults = defaultNarrationProviderConfigs.find((c) => c.id === 'qwen-tts');
assert.ok(qwenTtsDefaults, 'defaultNarrationProviderConfigs 应该包含 qwen-tts');
assert.equal(KNOWN_VOICE_CATALOG['qwen-tts'].length, 4);
assert.deepEqual(
  KNOWN_VOICE_CATALOG['qwen-tts'].map((v) => v.id),
  qwenTtsDefaults!.defaultVoices
);

// qwen3-tts-flash 目录：48 个，每条 id/label/description 非空，id 无重复
const flashCatalog = KNOWN_VOICE_CATALOG['qwen3-tts-flash'];
assert.equal(flashCatalog.length, 48);
for (const voice of flashCatalog) {
  assert.ok(voice.id.trim().length > 0, `voice.id 不能为空: ${JSON.stringify(voice)}`);
  assert.ok(voice.label.trim().length > 0, `voice.label 不能为空: ${JSON.stringify(voice)}`);
  assert.ok(voice.description.trim().length > 0, `voice.description 不能为空: ${JSON.stringify(voice)}`);
}
const flashIds = flashCatalog.map((v) => v.id);
assert.equal(new Set(flashIds).size, flashIds.length, 'qwen3-tts-flash 音色 id 不应有重复');

// resolveKnownVoiceCatalog：精确匹配、大小写不敏感、日期版本号归一化、未知返回 null
assert.equal(resolveKnownVoiceCatalog('qwen3-tts-flash'), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('QWEN3-TTS-FLASH'), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('  qwen3-tts-flash  '), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('qwen3-tts-flash-2025-11-27'), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('qwen3-tts-flash-2025-09-18'), flashCatalog);
assert.equal(resolveKnownVoiceCatalog('qwen-tts'), KNOWN_VOICE_CATALOG['qwen-tts']);
assert.equal(resolveKnownVoiceCatalog('tts-1'), null);
assert.equal(resolveKnownVoiceCatalog('qwen3-tts-instruct-flash'), null, '不应该误匹配 instruct-flash 系列');
assert.equal(resolveKnownVoiceCatalog(''), null);

// toggleVoiceSelection：勾选/取消、按目录顺序排列、保留目录外音色且不丢失其相对顺序
assert.equal(toggleVoiceSelection('', flashCatalog, 'Ethan'), 'Ethan');
assert.equal(toggleVoiceSelection('Ethan', flashCatalog, 'Cherry'), 'Cherry,Ethan');
assert.equal(toggleVoiceSelection('Cherry,Ethan', flashCatalog, 'Cherry'), 'Ethan');
assert.equal(
  toggleVoiceSelection('Cherry,CustomVoiceX', flashCatalog, 'Ethan'),
  'Cherry,Ethan,CustomVoiceX',
  '勾选已知音色时，不在目录里的 CustomVoiceX 必须原样保留在结尾'
);
assert.equal(
  toggleVoiceSelection('Cherry,CustomVoiceX', flashCatalog, 'Cherry'),
  'CustomVoiceX',
  '取消掉唯一的已知音色后，目录外音色仍然保留'
);

// resolveDefaultVoiceSelection：只在 create 模式且当前音色为空（含纯空白）时返回目录前 4 个；否则 null
assert.deepEqual(
  resolveDefaultVoiceSelection('create', flashCatalog, ''),
  ['Cherry', 'Serena', 'Ethan', 'Chelsie']
);
assert.deepEqual(
  resolveDefaultVoiceSelection('create', flashCatalog, '   '),
  ['Cherry', 'Serena', 'Ethan', 'Chelsie']
);
assert.deepEqual(
  resolveDefaultVoiceSelection('create', KNOWN_VOICE_CATALOG['qwen-tts'], ''),
  ['Cherry', 'Serena', 'Ethan', 'Chelsie']
);
assert.equal(resolveDefaultVoiceSelection('edit', flashCatalog, ''), null);
assert.equal(resolveDefaultVoiceSelection('create', flashCatalog, 'Ethan'), null);

console.log('narration-voice-catalog tests passed');
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node scripts/narration-voice-catalog.test.ts`
Expected: 报错 `Cannot find module '../lib/narration-providers/voice-catalog.ts'`（文件还不存在）

- [ ] **Step 3: 实现 `lib/narration-providers/voice-catalog.ts`**

```ts
// lib/narration-providers/voice-catalog.ts
/**
 * 已知模型的音色目录：按模型名索引，命中的模型在设置表单里用勾选列表代替自由文本。
 * 只有 openai-compatible-tts 协议下的具体已知模型才查这张表——协议类型本身不能预判
 * 背后是哪个模型，详见 lib/narration-providers/config.ts 对 openai-compatible-tts
 * defaultVoices 留空的说明。
 */

export interface KnownVoice {
  /** 传给 API 的 voice 参数值，如 "Cherry" */
  id: string;
  /** 官方中文音色名，用于 checkbox 显示，如 "芊悦" */
  label: string;
  /** 官方人设描述，用于 hover tooltip */
  description: string;
}

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

/**
 * 解析模型名对应的已知音色目录：trim + 大小写不敏感精确匹配；
 * qwen3-tts-flash 的带日期版本号（如 qwen3-tts-flash-2025-11-27）归一到同一目录。
 * 未命中返回 null。
 */
export function resolveKnownVoiceCatalog(model: string): KnownVoice[] | null {
  const key = model.trim().toLowerCase();
  if (!key) return null;
  for (const [catalogKey, voices] of Object.entries(KNOWN_VOICE_CATALOG)) {
    if (catalogKey.toLowerCase() === key) return voices;
  }
  if (/^qwen3-tts-flash-\d{4}-\d{2}-\d{2}$/.test(key)) {
    return KNOWN_VOICE_CATALOG['qwen3-tts-flash'];
  }
  return null;
}

/**
 * 切换一个音色的勾选状态，返回新的逗号分隔字符串。
 * 已知音色按 catalog 原始顺序排在前面；currentVoicesCsv 里已存在但不在 catalog 中的
 * "目录外音色" 原样保留、按其原有相对顺序追加在后，不会因为这次切换被丢弃。
 */
export function toggleVoiceSelection(currentVoicesCsv: string, catalog: KnownVoice[], toggledId: string): string {
  const current = currentVoicesCsv
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const catalogIds = new Set(catalog.map((v) => v.id));
  const selectedKnown = new Set(current.filter((v) => catalogIds.has(v)));
  const unknown = current.filter((v) => !catalogIds.has(v));

  if (selectedKnown.has(toggledId)) {
    selectedKnown.delete(toggledId);
  } else {
    selectedKnown.add(toggledId);
  }

  const orderedKnown = catalog.filter((v) => selectedKnown.has(v.id)).map((v) => v.id);
  return [...orderedKnown, ...unknown].join(',');
}

/**
 * 仅当 mode === 'create' 且 currentVoicesCsv（trim 后）为空时，返回 catalog 前 4 个音色 id 作为默认勾选建议；
 * 其余情况（编辑模式，或音色框已有内容）一律返回 null，调用方收到 null 就什么都不做。
 */
export function resolveDefaultVoiceSelection(
  mode: 'create' | 'edit',
  catalog: KnownVoice[],
  currentVoicesCsv: string
): string[] | null {
  if (mode !== 'create') return null;
  if (currentVoicesCsv.trim() !== '') return null;
  return catalog.slice(0, 4).map((v) => v.id);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node scripts/narration-voice-catalog.test.ts`
Expected: 输出 `narration-voice-catalog tests passed`，退出码 0

- [ ] **Step 5: Commit**

```bash
git add lib/narration-providers/voice-catalog.ts scripts/narration-voice-catalog.test.ts
git commit -m "feat: add known voice catalog for narration providers"
```

---

### Task 2: `ProviderForm` 接入音色勾选 UI

**Files:**
- Modify: `app/settings/page.tsx`

> 本任务没有自动化测试（项目没有组件级测试基础设施，`ProviderForm` 是纯 UI 交互）。用 `npx tsc --noEmit` + `npm run lint` 做类型/静态检查，用 `npm run dev` 手动过一遍关键路径。

- [ ] **Step 1: 引入新模块**

在 `app/settings/page.tsx` 顶部 import 区块，紧跟在现有两行 import 之后新增一行：

```ts
import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import { resolveKnownVoiceCatalog, toggleVoiceSelection, resolveDefaultVoiceSelection } from '@/lib/narration-providers/voice-catalog';
```

（只新增第 3 行，前两行原样保留。）

- [ ] **Step 2: 给 `<ProviderForm>` 调用点传 `mode`**

找到（大致在文件中部，「新建供应商 / 编辑供应商」卡片内）：

```tsx
              <ProviderForm category={active} form={form} onChange={setForm} />
```

改成：

```tsx
              <ProviderForm category={active} form={form} mode={creating ? 'create' : 'edit'} onChange={setForm} />
```

- [ ] **Step 3: 给 `ProviderForm` 加 `mode` 入参 + 新增 `applyVoiceDefaultsIfNeeded` 局部辅助函数**

找到：

```tsx
function ProviderForm({
  category,
  form,
  onChange,
}: {
  category: Category;
  form: ProviderFormState;
  onChange: (form: ProviderFormState) => void;
}) {
  const isVideoKling = category === 'video' && form.type === 'kling';

  return (
```

改成：

```tsx
function ProviderForm({
  category,
  form,
  mode,
  onChange,
}: {
  category: Category;
  form: ProviderFormState;
  mode: 'create' | 'edit';
  onChange: (form: ProviderFormState) => void;
}) {
  const isVideoKling = category === 'video' && form.type === 'kling';

  /**
   * narration 分类下，接口类型/模型名变化后如果新组合命中已知音色目录且当前音色为空
   * （仅新建模式），补上目录前 4 个音色，减少用户手动勾选；其余情况原样返回 next.voices。
   */
  const applyVoiceDefaultsIfNeeded = (next: { type: string; model: string; voices: string }): string => {
    if (category !== 'narration' || next.type !== 'openai-compatible-tts') return next.voices;
    const catalog = resolveKnownVoiceCatalog(next.model);
    if (!catalog) return next.voices;
    const defaults = resolveDefaultVoiceSelection(mode, catalog, next.voices);
    return defaults ? defaults.join(',') : next.voices;
  };

  return (
```

- [ ] **Step 4: 接口类型下拉框切换时也应用默认音色**

找到（「接口类型」`<select>` 的 `onChange`）：

```tsx
          onChange={(e) => {
            const nextType = e.target.value;
            // 便利项：narration 分类下切到 qwen-tts 且音色还没填时，自动带入已知的内置音色，
            // 减少用户手动输入；不影响 openai-compatible-tts（其音色必须由用户自己核实填写）。
            if (category === 'narration' && nextType === 'qwen-tts' && !form.voices.trim()) {
              onChange({ ...form, type: nextType, voices: 'Cherry,Serena,Ethan,Chelsie' });
            } else {
              onChange({ ...form, type: nextType });
            }
          }}
```

改成：

```tsx
          onChange={(e) => {
            const nextType = e.target.value;
            // 便利项：narration 分类下切到 qwen-tts 且音色还没填时，自动带入已知的内置音色，减少用户手动输入。
            // 切到其他类型（含 openai-compatible-tts）走 applyVoiceDefaultsIfNeeded：只有当前模型名也命中
            // 已知音色目录时才会补默认音色，命不中时原样保留 voices，不会替用户瞎猜。
            if (category === 'narration' && nextType === 'qwen-tts' && !form.voices.trim()) {
              onChange({ ...form, type: nextType, voices: 'Cherry,Serena,Ethan,Chelsie' });
            } else {
              onChange({
                ...form,
                type: nextType,
                voices: applyVoiceDefaultsIfNeeded({ type: nextType, model: form.model, voices: form.voices }),
              });
            }
          }}
```

- [ ] **Step 5: 模型名输入框变化时应用默认音色**

找到：

```tsx
      {(category !== 'narration' || form.type === 'openai-compatible-tts') && (
        <Field label={category === 'video' ? '默认模型' : '模型名'}>
          <input value={form.model} onChange={(e) => onChange({ ...form, model: e.target.value })} className="input-field" placeholder={category === 'narration' ? 'tts-1' : 'gpt-4o / kling-v3'} />
        </Field>
      )}
```

改成：

```tsx
      {(category !== 'narration' || form.type === 'openai-compatible-tts') && (
        <Field label={category === 'video' ? '默认模型' : '模型名'}>
          <input
            value={form.model}
            onChange={(e) => {
              const nextModel = e.target.value;
              onChange({
                ...form,
                model: nextModel,
                voices: applyVoiceDefaultsIfNeeded({ type: form.type, model: nextModel, voices: form.voices }),
              });
            }}
            className="input-field"
            placeholder={category === 'narration' ? 'tts-1' : 'gpt-4o / kling-v3'}
          />
        </Field>
      )}
```

- [ ] **Step 6: 「可选音色」字段改为调用新组件，并新增 `NarrationVoicesField` 组件**

找到：

```tsx
      {category === 'narration' && (
        <Field label="可选音色" className="sm:col-span-2">
          <input
            value={form.voices}
            onChange={(e) => onChange({ ...form, voices: e.target.value })}
            className="input-field font-mono text-xs"
            placeholder="例如：Cherry,Serena,Ethan,Chelsie（需与该 Base URL / 模型实际支持的音色一致，逗号分隔，留空则该供应商无法用于合成）"
          />
        </Field>
      )}
```

改成：

```tsx
      {category === 'narration' && <NarrationVoicesField form={form} onChange={onChange} />}
```

然后在 `ProviderForm` 函数结束的右花括号 `}` 之后、`function Field(...)` 定义之前，新增一个组件（这一段是全新代码，不是替换）：

```tsx
function NarrationVoicesField({
  form,
  onChange,
}: {
  form: ProviderFormState;
  onChange: (form: ProviderFormState) => void;
}) {
  const catalog = form.type === 'openai-compatible-tts' ? resolveKnownVoiceCatalog(form.model) : null;

  if (!catalog) {
    return (
      <Field label="可选音色" className="sm:col-span-2">
        <input
          value={form.voices}
          onChange={(e) => onChange({ ...form, voices: e.target.value })}
          className="input-field font-mono text-xs"
          placeholder="例如：Cherry,Serena,Ethan,Chelsie（需与该 Base URL / 模型实际支持的音色一致，逗号分隔，留空则该供应商无法用于合成）"
        />
      </Field>
    );
  }

  const selected = new Set(
    form.voices
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
  const catalogIds = new Set(catalog.map((v) => v.id));
  const unknownVoices = [...selected].filter((v) => !catalogIds.has(v));

  return (
    <Field label="可选音色" className="sm:col-span-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-[10px] border border-hairline p-3 sm:grid-cols-3">
        {catalog.map((voice) => (
          <label key={voice.id} title={voice.description} className="flex cursor-pointer items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={selected.has(voice.id)}
              onChange={() => onChange({ ...form, voices: toggleVoiceSelection(form.voices, catalog, voice.id) })}
              className="h-3.5 w-3.5 rounded border-hairline accent-accent"
            />
            <span>{voice.id}（{voice.label}）</span>
          </label>
        ))}
      </div>
      {unknownVoices.length > 0 && (
        <p className="mt-1.5 text-xs text-ink-tertiary">未识别音色：{unknownVoices.join(', ')}</p>
      )}
    </Field>
  );
}
```

放置位置：紧跟在 `ProviderForm` 函数体最后一个 `}` 之后，`function Field({ label, children, className }...) {` 之前。

- [ ] **Step 7: 类型检查 + lint**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无输出（无类型错误）

Run: `npm run lint`
Expected: 无 error（若有 pre-existing warning 与本次改动无关可忽略，但不能有新增 error）

- [ ] **Step 8: 手动过一遍浏览器**

Run: `npm run dev`，打开 `http://localhost:3000/settings`，切到「口播配音」标签页，依次验证：

1. 点「添加供应商」→ 接口类型选「OpenAI 兼容 TTS」→ 模型名填 `qwen3-tts-flash` → 「可选音色」应从文本框变成 checkbox 网格，且 `Cherry`/`Serena`/`Ethan`/`Chelsie` 四个默认勾选。
2. 勾选/取消其中几个 → 保存 → 重新点「编辑」该供应商 → checkbox 勾选状态应与保存前一致，且**不会**重新触发默认勾选（比如你保存时全部取消勾选，再次编辑打开应该还是全部未勾选，不会跳回默认 4 个）。
3. 把模型名改成 `qwen3-tts-flash-2025-11-27` → 仍应显示同一套 48 个 checkbox（归一到同一目录）。
4. 把模型名改成一个不认识的值（如 `my-custom-model`）→ 「可选音色」应退回自由文本框，且框内内容保留刚才 checkbox 生成的逗号分隔字符串，不清空。
5. 鼠标悬停在任意一个 checkbox 的文字上 → 应显示该音色的完整人设描述 tooltip。
6. 新建一个「Qwen TTS（阿里云 DashScope）」类型的供应商 → 确认这条路径的行为和改动前一致（自由文本 + 切换类型时预填同样 4 个音色），未受本次改动影响。

全部符合预期后再进入下一步。

- [ ] **Step 9: Commit**

```bash
git add app/settings/page.tsx
git commit -m "feat: checkbox voice picker for known narration models"
```

---

## 完成后自查（对照 spec）

- [x] Task 1 覆盖 spec 「1. 已知音色目录」+「辅助函数」小节的全部内容（数据 + 3 个函数 + 一致性测试）。
- [x] Task 2 覆盖 spec 「2. ProviderForm 的可选音色字段行为」「3. 默认勾选」的全部内容（触发条件、目录外音色保留、mode 门禁）。
- [x] spec 「4. 不变的部分」在整个计划中没有任何一步触碰 `lib/final-video/tts.ts`、`lib/narration-providers/config.ts`、数据库 schema、`components/FinalVideoPanel.tsx`——符合非目标。
