# 执行文档：新分镜图「已上传素材」改为框内滚动 + 左侧精简 + 文件名搜索

> 给实现方 AI 的说明：本文件是**精确执行手册**。请严格按「执行步骤」逐条改，**不要改动范围以外的任何代码**（见「硬性边界」）。完成后由 review 方逐条核对「验收标准」。

---

## 1. 背景（为什么改）

用户在「分镜」标签页的 **新分镜图 → 已上传素材** 宫格里会上传大量「原始分镜图」（实际场景：9 个产品 × 每个 5–9 张，常超过 **100 张**，截图里已上传 81 张）。

当前该宫格**没有任何高度上限**，图越多框越长，导致：

- 要往下滚很久才能到下面的「分镜组」区域；
- 想再上传时，拖拽框在最上面，又得滚回页面顶部才能拖。

**目标产出**：图多到一定程度后，宫格**不再向下无限拉伸**，而是在**框内出现竖向滚动条**，框内滚动**不带动外层页面**；左侧拖拽框保持在左、精简置顶，始终可见可拖；并新增**按文件名搜索/筛选**的小输入框。

---

## 2. 问题定位（架构现状）

核心组件：**`components/AssetUploadGrid.tsx`**（左 360px 上传栏 + 右 1fr 已上传宫格的统一组件）。

被两处复用，**改一处两处都受益**：

| 用途 | 文件:行 | usage | maxSelection |
| --- | --- | --- | --- |
| 新场景图生成 → 上传原始场景图 A | `app/projects/[id]/page.tsx:746` | `scene_seed` | 1 |
| **新分镜图 → 上传原始分镜图（本次主诉）** | `app/projects/[id]/page.tsx:1088` | `shot_source` | 9 |

`AssetUploadGrid.tsx` 关键结构：

- `:86` 外层两列网格 `grid gap-4 lg:grid-cols-[360px_1fr]`（grid 子项默认 `align-items:stretch`，所以左侧上传栏被右侧宫格撑成等高的大灰块）。
- `:87` 左列上传栏（内含 `ImageUploader`，且传入 `files={[]}`，所以 `ImageUploader` 自身的缩略图列表在这里**永远不渲染**）。
- `:108`–`:188` 右列「已上传素材」白卡：表头（`:109`–`:119`）+ 宫格（`:126` `grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3`，**无 max-height、无 overflow，这是无限拉伸的根因**）。
- `:191`–`:199` 悬停放大预览 popover：用 `.theme-preview-popover`（`globals.css:565` 为 `position: fixed`），且渲染在滚动容器**之外**，因此加内部滚动**不会**裁切或错位它。

辅助事实：

- 项目用 **Tailwind v4**，可直接用 `max-h-[75vh] overflow-y-auto overscroll-contain` 等任意值类。
- `Icon.tsx`（`components/ui/Icon.tsx`）**没有 `search` 图标**，需新增（见步骤 1）。已用到的有 `close`、`folder`。
- `.input-field`（`globals.css:72`）默认 `width:100%`，故搜索框必须放进**定宽容器**里，input 用 100% 撑满容器，避免宽度类特异性冲突。

---

## 3. 硬性边界（免得乱来）

- **只允许改这两个文件**：`components/AssetUploadGrid.tsx`、`components/ui/Icon.tsx`。
- **不要**改 `app/projects/[id]/page.tsx`、不要改任何 API、不要改 `ImageUploader.tsx`。
- **不要**改动卡片本身的 JSX（图片卡、选中角标、删除按钮、悬停预览逻辑都保持原样）。
- **不要**改选择逻辑 `toggle` / `selectedIds` / `selectedIndex` 的算法。
- **不要**改任何中文文案的既有含义；新增文案按本文给定。
- 不引入新依赖、不引入新全局 CSS（滚动条沿用浏览器默认即可）。
- 搜索为**纯前端**过滤，不发请求、不分页、不虚拟列表。

---

## 4. 执行步骤（精确改动）

### 步骤 1 — 给 `Icon.tsx` 新增 `search`（放大镜）图标

文件 `components/ui/Icon.tsx`。

**1a. 类型 union 末尾加 `"search"`**（`:9`）：

```tsx
  | "cpu" | "sparkle" | "users" | "monitor" | "film" | "search";
```

**1b. `PATHS` 里加一项**（放在 `film:` 那一项后面即可）：

```tsx
  search: (<><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>),
```

> 理由：搜索框左侧放放大镜更直观，且复用现有 `Icon` 体系（统一 1.6 描边）。

---

### 步骤 2 — `AssetUploadGrid.tsx` 新增搜索状态与过滤结果

在 `const [deletingId, setDeletingId] = useState<string | null>(null);`（`:52`）**之后**插入：

```tsx
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAssets = normalizedQuery
    ? assets.filter((asset) => asset.filename.toLowerCase().includes(normalizedQuery))
    : assets;
```

> 关键架构点：过滤只影响**展示**（`filteredAssets`），**不动 `selectedIds`**。`selectedIndex` 仍用 `selectedIds.indexOf(asset.id)` 计算（基于全局选择顺序，不是过滤后列表），所以被过滤掉的已选图序号不会乱，清空搜索后序号依旧连续正确。

---

### 步骤 3 — 替换右列表头，加入搜索框

把表头整块（`:109`–`:119`）：

**旧：**
```tsx
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">已上传素材</h3>
              <p className="mt-1 text-xs text-ink-secondary">已上传 {assets.length} 张，{selectionLabel}</p>
            </div>
            {selectedIds.length > 0 && (
              <button type="button" onClick={() => onSelectionChange([])} className="btn-secondary btn-sm text-xs">
                清空选择
              </button>
            )}
          </div>
```

**新：**
```tsx
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink">已上传素材</h3>
              <p className="mt-1 text-xs text-ink-secondary">
                已上传 {assets.length} 张{normalizedQuery ? `，筛选出 ${filteredAssets.length} 张` : ''}，{selectionLabel}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {assets.length > 0 && (
                <div className="relative w-full sm:w-56">
                  <Icon
                    name="search"
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary"
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="按文件名搜索…"
                    className="input-field pl-8 pr-7 text-xs"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-tertiary transition hover:text-ink"
                      title="清除搜索"
                      aria-label="清除搜索"
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
              )}
              {selectedIds.length > 0 && (
                <button type="button" onClick={() => onSelectionChange([])} className="btn-secondary btn-sm text-xs whitespace-nowrap">
                  清空选择
                </button>
              )}
            </div>
          </div>
```

> 要点：搜索框用 `relative w-full sm:w-56` **定宽容器**包住，`input-field` 自身 `width:100%` 撑满容器（避免特异性冲突）；窄屏自动占满整行（`flex-wrap`）。计数会附带「筛选出 N 张」。

---

### 步骤 4 — 给宫格套「框内滚动」容器，并改用 `filteredAssets`

定位到宫格条件渲染（`:121` 起）。

**4a. 把空态三元改成「空 / 无匹配 / 列表」三分支，并插入滚动容器开头。**

**旧（`:121`–`:126`）：**
```tsx
          {assets.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-hairline bg-surface-subtle text-sm text-ink-tertiary">
              {emptyText}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {assets.map((asset) => {
```

**新：**
```tsx
          {assets.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-hairline bg-surface-subtle text-sm text-ink-tertiary">
              {emptyText}
            </div>
          ) : filteredAssets.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-hairline bg-surface-subtle text-sm text-ink-tertiary">
              没有匹配「{query}」的素材
            </div>
          ) : (
            <div className="max-h-[75vh] overflow-y-auto overscroll-contain rounded-[14px] p-1 pr-2">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                {filteredAssets.map((asset) => {
```

**4b. 宫格收尾补一层闭合 `</div>`。**

**旧（宫格 map 结束处，`:185`–`:187`）：**
```tsx
              })}
            </div>
          )}
```

**新：**
```tsx
                })}
              </div>
            </div>
          )}
```

> 中间每张卡片的 JSX（`:127`–`:184`）**保持完全不变**，只把数据源从 `assets.map` 换成 `filteredAssets.map`（已在 4a 体现），并整体多缩进一层（可选，缩进不影响功能）。
>
> 类名释义：`max-h-[75vh]` = 约一屏 4 行后封顶（用户已选定）；`overflow-y-auto` = 仅在超高时出现滚动条；`overscroll-contain` = **框内滚到顶/底不带动外层页面**（精确满足「外面滑动不会受影响」）；`p-1 pr-2` = 防止边缘卡片的 `ring`/阴影被裁切，并给滚动条留位。

---

### 步骤 5 — 左侧上传栏精简置顶，不再被撑高

左列容器（`:87`）加 `self-start`：

**旧：**
```tsx
        <div className="rounded-lg border border-hairline bg-surface-subtle p-4">
```

**新：**
```tsx
        <div className="self-start rounded-lg border border-hairline bg-surface-subtle p-4">
```

> 理由：`self-start`（`align-self:start`）让左列**只包住自身内容**（标题+拖拽框），不再随右侧宫格拉伸成大灰块。右侧宫格框内滚动时，左侧拖拽框始终在左上方可见，用户**无需回到页面顶部**即可继续拖拽上传。位置仍在左侧（用户已确认保留左侧、不做 sticky 吸顶）。

---

## 5. 不在本次范围（已知但不动）

- `ImageUploader.tsx:164` 自身的缩略图宫格也无高度上限，但它**仅在** `app/projects/new/page.tsx`（旧建项目页「待处理图片」，最多 50 张小图）渲染；在本次涉及的 `AssetUploadGrid` / `ShotSetPanel` 里都传 `files={[]}` 不渲染。**本次不改**，如需可后续单独处理。

---

## 6. 验收标准（review 逐条核对）

1. **封顶+框内滚动**：分镜页「已上传素材」有 80+ 张时，区块高度不再无限增长；超过约 75vh 后出现**框内**竖向滚动条。
2. **不联动外层**：框内滚到顶/底，外层页面不被带动（`overscroll-contain` 生效）。
3. **左侧精简**：左侧「上传原始分镜图」不再是大灰块；右侧框内滚动时左侧拖拽框始终可见，无需回到页面顶部即可上传。
4. **搜索可用**：表头有搜索框，输入如 `VM1A-A` 即时过滤；计数显示「已上传 81 张，筛选出 N 张」；有内容时显示 ❌ 清除按钮，点击清空。
5. **搜索不破坏选择**：被过滤掉的已选图片仍保留在选择中，序号不变；清空搜索后恢复显示且序号连续正确。
6. **无匹配占位**：搜索无结果时显示「没有匹配「xxx」的素材」，不是空白。
7. **预览正常**：悬停放大预览仍正常、不被滚动容器裁切。
8. **两处一致无回归**：同组件用于「新场景图生成 → 上传原始场景图 A」标签页时行为一致（`maxSelection=1` 仍单选）。
9. **删除正常**：卡片 ❌ 删除仍可用，删除后计数与宫格更新。
10. **质量门槛**：`npm run lint` 通过，无新增 TS 错误，控制台无报错；`Icon` 的 `name="search"` 类型校验通过。

---

## 7. 验证方法（端到端）

```bash
npm run dev:win   # Windows 下起 127.0.0.1:3000
npm run lint      # 类型/规范检查
```

手测路径：

1. 打开一个含 80+ 张原始分镜图的项目 → **分镜**标签页 → 「新分镜图」。
2. 核对验收 1/2/3：滚动封顶、框内滚动不带动外层、左侧拖拽框常在。
3. 核对验收 4/5/6：搜索过滤、计数、清除、选择序号、无匹配占位。
4. 选中数张（注意序号），输入搜索过滤掉其中几张，确认序号不乱；清空搜索复原。
5. 悬停某张图确认放大预览（验收 7）。
6. 切到**场景**标签页「新场景图生成」做一次冒烟，确认单选与上传无回归（验收 8）。
7. 删除一张图确认更新（验收 9）。
8. 跑 `npm run lint`（验收 10）。

---

## 8. 改动文件清单

- `components/ui/Icon.tsx` —— 新增 `search` 图标（类型 + PATHS）。
- `components/AssetUploadGrid.tsx` —— 搜索状态/过滤、表头搜索框、宫格框内滚动容器（`max-h-[75vh] overflow-y-auto overscroll-contain` + 改用 `filteredAssets`）、左列 `self-start`。
