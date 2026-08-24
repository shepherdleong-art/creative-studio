# 批量封面标题「按脚本单独设置样式」执行文档

> 本文是交给执行者的**零上下文自包含**实施文档：目标、现状、已核实契约、改动清单、测试、红线、
> 验证命令、停止点全部在文内。执行前先通读全文，再动手。
> 撰写日期 2026-08-24；仓库 `I:\m7-studio`（Next.js 16 App Router + React 19 + better-sqlite3 +
> TypeScript strict；UI 文案中文）。**本次零 schema/迁移改动**。

## 1. 任务目标

封面标题板块目前**整批统一**设置主/副标题样式（字体、字号、颜色、描边、斜体、横纵位置）。
用户验收反馈：各脚本标题长短不一，统一样式不可能条条合适，只有生成出来才发现问题、且已无机会修改。

本迭代把样式改为**按脚本单独设置**：

- 「预览脚本」下拉（上一迭代已落地，见 §2）升级为「选择当前正在调整哪份脚本」的入口；
- 每份脚本可有自己的完整样式（主+副），**未单独调整的脚本回落「整批基准样式」**；
- 对齐第 2 步配音配置的既有范式：按脚本编辑 + 「应用到全部脚本」按钮；
- 覆盖随 `defaultsJson` 冻结进版本（输入身份的一部分），渲染端按成片所属脚本取样式。

**不做**：framing（底图取景）保持整批统一——它管裁切不管标题长短；mode（无标题/预设/自定义）
保持整批统一；标题文字本身的编辑走既有脚本编辑入口，不在本板块。

## 2. 现状（上一迭代交付物，先读再改）

**工作树基线（2026-08-24 未提交改动，本文在此基础上继续）**：

- 封面标题卡已有「预览脚本」下拉：state `coverPreviewScriptId`、清单 `coverPreviewSources`
  （冻结时=快照，否则=已勾选脚本）、`coverPreview`（选中项失效自动回落第一条）、预览 SVG 与
  caption 跟随切换。定位标记：`aria-label="封面标题预览脚本"`。
- 播放头 CSS 修复：`components/mixcut/mixcut-content.module.css` 的 `.tlInner .tlPlayhead`
  （提高优先级抗 `.shell button` 重置）——与本任务无关，别碰。

**封面标题现状链路**：

- `lib/batch-production/cover-title.ts`：
  - `BatchCoverTitleSettings`（:26-31）= `{ mode, presetId, styles, framing }`；
  - `resolveBatchCoverTitleSettings(defaults)`（:43-59）：从 defaultsJson 容错解析四字段，
    样式过 `normalizeTextStyle`（缺字段按 1080 宽补默认）；
  - `loadFrozenCoverTitleConfig(db, planId)`（:127-143）：SQL 经
    `batch_output_plans.scriptSnapshotId → batch_script_snapshots.coverTitleJson`（标题文字）
    + `batch_production_versions.defaultsJson`（样式设置）；mode none / 样式缺失 / 主标题空 → null；
  - `applyFrozenCoverTitleToFile`（:149-167）：渲染接线点，按 planId 就地合成封面标题。
    **批量渲染与「换封面」重合成都走这里，天然按计划逐条解析**。
- `components/batch-production/BatchStepScripts.tsx`：
  - `BatchCoverTitleDraft`（:48-53）= `{ mode, presetId, styles, framing }`；
  - `updateCoverTitle`（:615-632，按字段 patch、进 preset/custom 时补默认样式与 framing）、
    `updateCoverStyle`（:634-640，写基准 `styles[kind]`）、`applyCoverPreset`（:642-651）、
    `saveCoverPreset`（:653-690）、`renderCoverTextStyleEditor`（:706-839）、
    `renderCoverTitleSection`（:842 起，含预览下拉）。
- `components/batch-production/BatchPreparationPanel.tsx`：草稿初值（:165-170，mode none + 全 null）；
  `confirmSnapshot` 提交体（:939-951）把四字段写进 `defaultsJson`；`onCoverTitleChange`
  已接 `markInputChanged`（:1815-1817），任何样式改动自动纳入「输入已修改」提示，无需额外接线。

## 3. 已核实契约（设计地基，已读源码）

1. **`defaultsJson` 是透传字段**：`BatchSnapshotInput.defaultsJson?: unknown`
   （`lib/batch-production/batch-flow.ts:35`），服务端不白名单校验、原样冻结（:312/316/326）。
   新增字段**不需要任何 schema/迁移/服务端改动**。
2. **输入身份比对**：`canonicalJson`（:121-130，键排序递归序列化）；冻结存储侧比对前会
   `delete identityDefaults.batchMusicPool`（:152-154，那是服务端运行期注入的，不算客户端输入）。
   客户端提交的 `defaultsJson` 与其余字段 canonical 不一致 → 形成新版本。
3. **空映射不写键（幂等红线）**：本功能上线前冻结的旧版本没有 `coverTitleStylesByScript` 键。
   若客户端在无覆盖时也提交 `coverTitleStylesByScript: {}`，旧批次再确认会因 canonical 多一个键
   而误判「输入变化」、白建新版本。所以**提交端空映射时省略该键**；有覆盖时带上（此时输入确实
   变了，建新版本是正确语义）。
4. **未勾选脚本的残留条目保留**：勾选状态本身属于输入身份（`scriptSelections` 参与比对）。
   清理残留条目反而会让「取消勾选再勾回」产生 canonical 抖动；留着不动，渲染端也只会按
   快照的 sourceScriptId 查，残留条目永远查不到。**不要顺手清理。**
5. **覆盖条目容错**：`defaultsJson` 由 UI 写入但读取端必须容忍损坏。条目值不是对象、或
   `primary`/`secondary` 都不是对象 → **跳过该条目**（不能让坏条目被 normalize 成全默认而
   遮蔽基准样式）；条目正常则两层都过 `normalizeTextStyle`（primary 按 `coverPrimary`、
   secondary 按 `coverSecondary`，1080 宽兜底，与基准同款）。
6. **UI 范式先例**：第 2 步配音配置就是按脚本单独设置 + 「应用到全部脚本」按钮
   （`BatchStepScripts.tsx` 内，`scripts/batch-preparation-workspace.test.mjs` 已断言
   `/应用到全部脚本/`）。封面标题照搬这套交互语言。
7. **既有测试形状**：`scripts/batch-cover-title.test.ts:33-38` 有 5 条
   `assert.deepEqual(resolveBatchCoverTitleSettings(...), { mode:'none', presetId:null, styles:null, framing:null })`
   ——返回形状加字段后这些是**机械更新**，不是行为回归。DB 夹具模式见 :160-234
   （`createBatchProduction` → `createBatchProductionVersion(defaultsJson)` →
   `createProjectScript(metadata.coverTitleJson)` → `snapshotScriptIntoBatch` →
   `createOutputPlansForSnapshot` → `loadFrozenCoverTitleConfig`）。

## 4. 改动清单

### 4.1 `lib/batch-production/cover-title.ts`（渲染端解析）

`BatchCoverTitleSettings` 加字段：

```ts
export interface BatchCoverTitleSettings {
  mode: BatchCoverTitleMode;
  presetId: string | null;
  styles: { primary: TextStyle; secondary: TextStyle } | null;
  /** 按脚本覆盖(sourceScriptId → 完整样式);缺省/无条目时回落 styles。 */
  stylesByScript: Record<string, { primary: TextStyle; secondary: TextStyle }>;
  framing: CoverFraming | null;
}
```

`resolveBatchCoverTitleSettings` 追加解析（所有缺省/非法路径返回 `stylesByScript: {}`）：

```ts
const byScriptRaw = asRecord(root.coverTitleStylesByScript);
const stylesByScript: BatchCoverTitleSettings['stylesByScript'] = {};
if (byScriptRaw) {
  for (const [scriptId, entry] of Object.entries(byScriptRaw)) {
    if (!scriptId) continue;
    const record = asRecord(entry);
    // 坏条目必须跳过,不能被 normalize 成全默认而遮蔽基准样式
    if (!record || (!asRecord(record.primary) && !asRecord(record.secondary))) continue;
    stylesByScript[scriptId] = {
      primary: normalizeTextStyle(record.primary, defaultTextStyle('coverPrimary', 1080)),
      secondary: normalizeTextStyle(record.secondary, defaultTextStyle('coverSecondary', 1080)),
    };
  }
}
```

`loadFrozenCoverTitleConfig`：SQL 加一列 `s.sourceScriptId AS sourceScriptId`，样式解析改为：

```ts
const styles = settings.stylesByScript[row.sourceScriptId] ?? settings.styles;
if (settings.mode === 'none' || !styles) return null; // 沿用既有门禁顺序:先取样式再判空
// ... return { primary, secondary, styles, framing: settings.framing }
```

注意保持既有回落语义：基准 `styles` 缺失且无覆盖时仍返回 null（现有 v4 测试用例）。

### 4.2 `components/batch-production/BatchStepScripts.tsx`（UI 主体）

- `BatchCoverTitleDraft` 加 `stylesByScript: Record<string, { primary: TextStyle; secondary: TextStyle }>`
  （稳定完整形状，默认 `{}`）；`updateCoverTitle` 的 patch 逻辑按同款三态写法扩展该字段。
- 编辑目标解析（在 `renderCoverTitleSection` 内，复用上一迭代的 `coverPreview`）：

```ts
// 冻结态整卡只读,不存在编辑目标;draft 下目标 = 预览下拉选中的脚本,未选脚本时 = 整批基准。
const coverEditScriptId = !frozen && coverPreview ? coverPreview.id : null;
const coverEffectiveStyles = coverEditScriptId
  ? coverTitle.stylesByScript[coverEditScriptId] ?? coverTitle.styles
  : coverTitle.styles;
```

- 两个样式编辑器绑定 `coverEffectiveStyles`（`hasTitle` 闸门已保证非空）；
  `updateCoverStyle` 改为：

```ts
function updateCoverStyle(kind: 'primary' | 'secondary', patch: Partial<TextStyle>): void {
  if (!coverTitle.styles) return;
  if (coverEditScriptId) {
    // 惰性建条目:从当前有效样式(覆盖或基准)整体复制再 patch,保证条目是完整形状
    const base = coverTitle.stylesByScript[coverEditScriptId] ?? coverTitle.styles;
    onCoverTitleChange({
      ...coverTitle,
      stylesByScript: {
        ...coverTitle.stylesByScript,
        [coverEditScriptId]: { ...base, [kind]: { ...base[kind], ...patch } },
      },
    });
    return;
  }
  onCoverTitleChange({
    ...coverTitle,
    styles: { ...coverTitle.styles, [kind]: { ...coverTitle.styles[kind], ...patch } },
  });
}
```

- `applyCoverPreset`：patch 里追加 `stylesByScript: {}`——**应用预设 = 整批重置回预设样式，
  已有单独调整全部清空**（可预期语义；之后再逐份微调）。
- 预览下拉行（`aria-label="封面标题预览脚本"` 那个 label）追加：
  - 当前脚本有覆盖条目时：`<span>`chip「已单独调整」+ 「恢复基准样式」小按钮
    （删除该脚本条目：`const { [id]: _removed, ...rest } = coverTitle.stylesByScript;` 写回 rest）；
  - 有选中脚本时显示「应用到全部脚本」按钮：`styles = 当前有效样式` + `stylesByScript: {}`
    （函数名建议 `applyCoverStyleToAllScripts`，与配音配置的按钮同文案、同语义）。
  - 冻结态全部 disabled（样式编辑器的 `disabled={frozen}` 已是先例）。
- `saveCoverPreset`：保存对象从 `coverTitle.styles` 换成 `coverEffectiveStyles`
  （存的是当前调整目标的样式）；其余逻辑不动。
- 板块说明文案（:885-887 附近）改写，建议：
  「标题文字来自各脚本的封面标题（第 3 步生成）。样式与位置**按脚本单独设置**：预览下拉选择
  当前调整的脚本，未单独调整的脚本沿用整批基准；应用预设会把整批重置为预设样式。确认整体输入后
  随版本冻结，改样式会形成批次新版本。」
- 编辑目标提示：有选中脚本时在样式编辑器上方显示
  「正在调整：脚本 N · <主标题>（仅对这份脚本生效）」；未勾选脚本时显示
  「未勾选脚本时，调整的是整批基准样式」。

### 4.3 `components/batch-production/BatchPreparationPanel.tsx`（容器）

- 初值（:165-170）补 `stylesByScript: {}`。
- `confirmSnapshot` 提交体（:939-951）的 `defaultsJson` 追加**条件字段**（空映射不写键，见 §3.3）：

```ts
...(Object.keys(coverTitle.stylesByScript).length > 0
  ? { coverTitleStylesByScript: coverTitle.stylesByScript }
  : {}),
```

### 4.4 测试

`scripts/batch-cover-title.test.ts`：

1. :33-38 五条 `deepEqual` 的期望值统一改为
   `{ mode: 'none', presetId: null, styles: null, stylesByScript: {}, framing: null }`；
   文件中其余 `deepEqual(resolve...)` 断言同步补 `stylesByScript` 字段。
2. 新增解析用例：
   - 正常映射：两条目均过 normalize（如 `fontSizePx: 1` → 8）；
   - 非法条目跳过（`null`、字符串、`{ primary: 42 }` 这类两层都不是对象的）；
   - `coverTitleStylesByScript: 'garbage'` → `{}`。
3. 新增 DB 场景（沿用 :160-234 夹具模式）：一个版本挂两份脚本快照，
   `defaultsJson = { coverTitleMode: 'custom', coverTitleStyles: 基准(如 color #ff0000),
   coverTitleStylesByScript: { [scriptA]: { primary: {...完整样式, color '#00ff00'}, secondary: {...} } } }`；
   脚本 A 的计划 → `loadFrozenCoverTitleConfig` 返回 `#00ff00`；脚本 B 的计划 → 返回基准 `#ff0000`；
   映射里再塞一个不存在脚本的条目，断言不影响 A/B。

`scripts/batch-preparation-workspace.test.mjs`（照既有 `assert.match(scripts, /.../)` 风格）追加：

```js
// 封面标题按脚本单独设置(2026-08-24):覆盖写入 defaultsJson 新字段,可恢复基准、可一键同步全部
assert.match(scripts, /coverTitleStylesByScript/);
assert.match(scripts, /恢复基准样式/);
assert.match(scripts, /已单独调整/);
assert.match(scripts, /applyCoverStyleToAllScripts/);
```

（「应用到全部脚本」与配音配置同文案，已有断言覆盖，不重复。）

### 4.5 文档

`docs/reference/批量生产模块.md` 的封面标题段落（「语义优先分配与封面标题（v17–v23）」节，
含 2026-08-24 刚加的「预览脚本下拉」半句）改写为按脚本覆盖语义，必须写清两条坑：
**空映射不写键保旧批次再确认幂等**；**残留条目不清理保勾选幂等**。

## 5. 不需要动

- **零 schema/迁移/服务端路由改动**：`defaultsJson` 透传（§3.1），快照路由与
  `batch-flow.ts`/`versions.ts` 全部不动。
- `batch-renderer.ts`、`batch-export.ts` 不动（封面标题解析入口就是
  `applyFrozenCoverTitleToFile`，4.1 改完它自动按脚本生效）。
- framing、mode、presetId 维持整批统一；冻结批次封面设置回填显示是既有缺口，**不在本迭代**。
- `components/mixcut/`、`components/final-edit/`、`lib/final-edit/`、`lib/media-core/` 只许 import。

## 6. 红线与 scope cut

- 不动 git（add/commit/push 一律禁止）；不顺手重构、不改无关格式、不引入新依赖。
- 工作树里 `app/globals.css`、`components/VideoGenerationPanel.tsx`、
  `scripts/video-bulk-prompt-ui-contract.test.mjs` 是另一任务的既有改动，不要碰。
- 上一迭代的未提交基线（预览下拉、`.tlInner .tlPlayhead`）是本任务的起点，不要回退。
- UI 颜色走设计令牌/Tailwind 语义类，不新增硬编码浅色值。

## 7. 验证清单（全部真跑，不许凭印象声明通过）

```bash
node scripts/batch-cover-title.test.ts             # 含 §4.4 新用例
node scripts/batch-preparation-workspace.test.mjs  # 含 §4.4 新断言
node scripts/batch-phase-e-ui-contract.test.mjs
node scripts/batch-batch-flow.test.ts              # defaultsJson 比对路径,零改动必须原样全绿
npx tsc --noEmit
npm run lint                                       # 0 error;触动的文件零新增 warning
```

浏览器冒烟（`npm run dev:win` 起服务 127.0.0.1:3000；可沿用 `outputs/probe-2026-08-24-playhead-cover.mjs`
的探针模式，Playwright headless）：

1. 项目 `1031ea6e-99e7-4689-a616-8ae5d393df78`（YZ4R，24 条已分析素材、3 脚本、有「预设1」）→
   智能混剪 → 批量生产 → 新建临时批次（探完**归档**，命名如「探针临时-可归档」）；
2. 准备素材勾 2 条 → 脚本与口播勾 2 份 → 封面标题模式「使用预设」→ 应用「预设1」；
3. 预览下拉切到脚本 2，调小主标题字号 → 断言预览 SVG 变化；切回脚本 1 → 断言字号不变
   （脚本 1 未单独调整、吃基准）；
4. 点「恢复基准样式」→ 脚本 2 回到基准；再调一次 → 点「应用到全部脚本」→ 两份脚本一致；
5. 截图留证（`outputs/probe-shots/`）。

渲染端不做真渲染冒烟（要跑完整批次，过重）；按脚本解析的正确性由 §4.4 的 DB 用例覆盖。

**预存失败基线**：`scripts/batch-render-smoke.test.ts` 在本机失败（ffmpeg 环境差异，2026-08-24
已确认与任务无关）。执行前先跑一遍拿基线；执行后它仍败是预期，不许当成自己改坏的，也不许顺手修。

## 8. 执行纪律与停止点

1. 动手前先读：本文 → `docs/reference/批量生产模块.md` → §2 列出的现状代码。
2. 改动最小化：§4 之外的文件一行都不该动；发现不得不动时停下汇报。
3. 停下并汇报的情形：本文与代码现状冲突（锚点找不到、契约已变）、需要动服务端/schema 才能达成、
   或测试出现无法归因的失败。
4. 汇报格式：改动/新增文件清单（带要点）、实际运行的验证命令与结果（贴关键输出）、偏离本文档的
   决定及原因、浏览器冒烟截图清单。
