# 工作台 UI 改版设计规格 · Apple 风格

**日期：** 2026-06-12
**状态：** 已通过方向验证，待实现计划（writing-plans）
**可视化稿：** `.superpowers/brainstorm/118-1781252957/content/`（`apple-home.html`、`apple-workbench.html`，本地服务 http://localhost:50246）

---

## 1. Context（为什么做）

当前界面是通用 Tailwind 默认观感（`blue-600` 主色、`system-ui` 字体、emoji 图标、`rounded-xl`+`shadow-sm` 白卡、蓝→白渐变 hero），辨识度低、偏“AI 生成感”。用户要求**精致极简**，并在可视化对比后明确选定 **Apple 官网（apple.com.cn）风格**作为目标语言；同时确认采用 **A：分阶段、先上线验证**的落地节奏。

目标产出：一套覆盖全站的 Apple 风格设计语言（令牌 + 组件类 + 外壳 + 各屏），**纯视觉/样式重构，不改变任何功能与交互行为**。

设计探索过程中已淘汰：B 瑞士极简（太寡淡）、C 深色画廊（整屏太暗、可视度低）、A 暖纸编辑（“太 Claude”——暖米底+衬线+陶土色）。

---

## 2. 设计方向（已锁定）

- **美学：** Apple（apple.com.cn）——纯白 + 浅灰分区 + 近黑文字、克制的 Apple 蓝、胶囊按钮、大圆角图卡、磨砂导航、充足留白、图片优先。
- **强调色：** Apple 蓝 `#0071E3`（仅用于按钮 / 链接 / 选中 / 焦点；不铺大面积）。
- **明暗：** 以**浅色为主**；**深色仅用于结果浏览 / 图库类图片屏**（Apple Photos 观感），放在 Phase 4。
- **图标：** 全部 emoji 换成细线 SVG 图标（SF Symbols 观感）。

---

## 3. 设计系统 / 令牌

> 落点：`app/globals.css`。Tailwind v4 已用 `@theme inline` 定义令牌、`@layer utilities` 定义工具类。**保留现有类名、替换其定义**是本次改版的核心杠杆——大量复用这些类的组件会“一键换肤”。

### 3.1 颜色

| 角色 | 值 | 用途 |
|---|---|---|
| `--surface` | `#FFFFFF` | 主背景 / 卡片 |
| `--surface-subtle` | `#F5F5F7` | 分区块 / 统计块 / 段控容器 / 表头底 |
| `--surface-hover` | `#FAFAFC` | 行 hover |
| `--text-primary` | `#1D1D1F` | 主文字 / 标题 |
| `--text-secondary` | `#6E6E73` | 次级文字 / 描述 |
| `--text-tertiary` | `#86868B` | 标签 / 表头 / 占位 |
| `--hairline` | `#E6E6EB` | 发丝线边框 / 分隔 |
| `--hairline-soft` | `#F0F0F3` | 表格行内分隔 |
| `--accent` | `#0071E3` | 强调色 |
| `--accent-hover` | `#0077ED` | 强调色 hover |
| `--focus-ring` | `rgba(0,113,227,.40)` | 焦点环 |

### 3.2 状态语义（7 态 → Apple 胶囊）

保留现有 7 个状态键，重映射为低饱和 Apple 胶囊（`底色 / 文字`，外加结果网格用的小圆点色）：

| 状态键 | 中文 | 胶囊底 / 文字 | 圆点 |
|---|---|---|---|
| `pending` | 等待 | `#EFEFF2` / `#6E6E73` | `#C7C7CC` |
| `running` | 运行中 | `#E8F1FF` / `#0071E3` | `#0071E3` |
| `succeeded` | 成功 | `#E7F7EE` / `#1B8E4D` | `#34C759` |
| `failed` | 失败 | `#FDEBEA` / `#D7372B` | `#FF3B30` |
| `retrying` | 重试 | `#FFF4E5` / `#B25E00` | `#FF9F0A` |
| `canceled` | 已取消 | `#EFEFF2` / `#A1A1A6`（删除线） | — |
| `needs_check` | 待补抓 | `#ECECFB` / `#5331D8` | `#5331D8` |

### 3.3 字体

**重要约束（本地离线工具）：** App 运行在 `127.0.0.1`、需离线可用 → 字体必须经 `next/font` 自托管（构建期拉取、运行期本地），**不得**在运行时引用 Google Fonts CDN（可视化稿用了 CDN，仅供预览）。

- **UI 无衬线：** 先用系统 SF / 苹方，再回退到自托管 Latin 字体——
  `-apple-system, BlinkMacSystemFont, "SF Pro Text", var(--font-ui), "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue", Arial, sans-serif`
  - Mac：真 SF Pro + 苹方；Windows：自托管 `--font-ui` + 系统微软雅黑。
  - `--font-ui` = **Inter**（`next/font/google`）——SF 最接近、最稳的开源替身（理由见 §9）。
- **中文：** 以系统为主（Mac 苹方 / Windows 微软雅黑），不强制打包重型 CJK 字体；保留 `Noto Sans SC` 作为兜底名。
- **等宽（数字 / ID / 代码）：** `ui-monospace, "SF Mono", var(--font-mono), Menlo, Consolas, monospace`，`--font-mono` = **JetBrains Mono**（`next/font/google`）。

**字号 / 字重 / 字距（type scale）：**

| 级别 | 字号 | 字重 | 字距 | 用途 |
|---|---|---|---|---|
| Display | 40–48px（响应式） | 600 | -0.022em | 首页 hero |
| Title | 28–32px | 600 | -0.02em | 页面主标题 |
| Section | 20–21px | 600 | -0.01em | 区块标题 |
| Card | 16px | 600 | — | 卡片标题 |
| Body | 14–15px | 400 | — | 正文 |
| Meta | 12.5–13px | 400 | — | 次级 / 元信息（`--text-secondary`） |
| Label | 11–12px | 600 | 0.04em / 大写 | 表头 / 字段标签（`--text-tertiary`） |
| Mono | 12–13px | 400–500 | — | 数字 / 文件名 / ID |

### 3.4 形状与深度

- **圆角：** 按钮/胶囊 `980px`（全圆）；卡片/图块 `18px`；图片格 `13–16px`；输入/选择/段控内项 `10px`（段控容器 `11px`）。
- **边框：** 默认发丝线 `1px var(--hairline)`；优先用 `--surface-subtle` 色块分区，**少用边框**。
- **阴影（极弱）：** 卡片 hover `0 8px 28px rgba(0,0,0,.08)`；浮层/模态 `0 20px 60px rgba(0,0,0,.14)`；常态卡片基本无阴影或 `0 1px 3px rgba(0,0,0,.06)`。

### 3.5 间距与布局

- 充足留白；内容居中、有最大宽度节奏（首页 hero/内容 ~`960–980px`；工作台可更宽）。
- 8px 基准节奏（卡片内距 16–22px、区块间距 24–40px、hero 上下 40–56px）。

### 3.6 动效

- 克制：`150–200ms ease`；卡片 hover 轻微上浮 + 弱阴影；导航/工具栏磨砂（`backdrop-filter: saturate(180%) blur(20px)`）；焦点用 Apple 蓝焦点环。无炫技动画。

### 3.7 图标

- 引入一套**细线 SVG 图标**（stroke 1.6、圆角端点），替换全部 emoji。新增 `components/ui/Icon.tsx`（按 `name` 渲染内联 SVG，支持 `size`/`className`/`stroke`）。
- 首批需要的图标：`chevron-left/right`、`download`、`play`、`pause`、`stop`、`retry/refresh`、`trash`、`plus`、`minus`、`check`、`alert`、`image`、`settings`、`key`、`logs(lines)`、`x/close`、`power`。
- emoji → 图标对照（示例）：🖼️→`image`、🔄→`retry`、🗑️→`trash`、✅→`check`、❌/⚠️→`alert`、🔑→`key`、⚙️→`settings`、📂→`image`/空态插画、← →`chevron-left`、× →`x`。

---

## 4. 组件原语层（globals.css 重写）

**策略：类名不变、定义替换**（最大化“一键换肤”），并新增缺失的原语。

重定义现有类：

- `.card` → 白底、`18px` 圆角、发丝线、无/极弱阴影、`p-4/5`。
- `.btn-primary` → Apple 蓝胶囊、白字、`980px`、`hover:--accent-hover`、禁用降透明。
- `.btn-secondary` → 浅灰胶囊（`--surface-subtle`）或发丝线白胶囊、深色字。
- `.btn-danger` → 红字 / 红边胶囊（破坏性动作用 Apple 红 `#FF3B30`，慎用大面积红底）。
- `.btn-sm` → 更小内距 + 13px。
- `.input-field` → `10px` 圆角、发丝线、`focus` 用 Apple 蓝细环（替换现 `ring-blue-500`）。
- `.label` → 11–12px、大写、`0.04em`、`--text-tertiary`。
- `.status-badge` + `.status-*` → §3.2 胶囊配色。

新增原语（供工作台/各屏复用）：

- `.pill`（通用胶囊标签）、`.segmented`/`.segmented > .on`（分段控件）、`.toolbar`（磨砂工具栏）、`.data-table`（发丝线表格 + 大写表头 + 等宽右对齐数字 + 蓝色文字操作）、`.tile`（大圆角图块/统计块）、`.icon-btn`（线性图标按钮，hover 浅灰底）、`.link-accent`（蓝色文字链接，hover 下划线，可带 `›`）。

---

## 5. 应用外壳

- **`app/layout.tsx`：** 经 `next/font` 注入 `--font-ui` / `--font-mono` 到 `<html>`；背景从 `bg-gray-50` 改为白；`<main>` 居中、留白节奏按 Apple；语言保持 `zh-CN`。
- **`components/Header.tsx`：** 改为**磨砂 sticky 顶栏**（半透明白 + `backdrop-blur` + 发丝线底）；品牌去 emoji；导航链接（项目 / 供应商）；右侧“新建项目”蓝色胶囊；“停止服务”改为线性图标按钮 + 确认弹窗按 Apple sheet 样式。

---

## 6. 各屏方案

### 6.1 首页 `app/page.tsx`（Phase 1）
- 去掉蓝→白渐变 hero 与 emoji；改为**居中大标题 hero**（Display）+ 次级说明 + 蓝色胶囊“新建项目” + “了解流程 ›”文字链接。
- 状态汇总：4 个 `--surface-subtle` 大圆角统计块、大号数字（运行中用蓝）。
- 项目列表：大圆角**图卡**（左侧缩略图 + 名称 + 状态胶囊 + 元信息 + 发丝线进度条 + 右侧 `›`）。首次使用引导改为 Apple 简洁分步。

### 6.2 设置页 `app/settings/page.tsx` + `components/ProviderSettings.tsx`（Phase 2）
- 供应商卡片 Apple 化（白卡 + 发丝线 + 状态胶囊）；编辑态用浅蓝/发丝线高亮代替 `border-blue-300 bg-blue-50`。
- 表单用新 `.input-field` / `.label`；底部安全提示改为低饱和信息条（非亮黄）。

### 6.3 新建项目向导 `app/projects/new/page.tsx`（Phase 2）
- 工作流切换（复杂 / 旧版）改为**分段控件**。
- 各分区为大圆角卡片；供应商选择器为可选**图块**（选中=蓝边/浅蓝底）；成本预览为 `--surface-subtle` 信息块；折叠高级项保留 `<details>` 但 Apple 化。

### 6.4 工作台核心 `app/projects/[id]/page.tsx` + 组件（Phase 3）
- **工具栏**：磨砂；`‹ 项目` 返回 + 项目名 + 状态胶囊 + 右侧线性图标动作（运行日志 / 导出）+ “开始运行”蓝胶囊。
- **标签**：`ProjectWorkbenchTabs.tsx` → 分段控件（场景/分镜/脚本/视频）；右侧队列摘要 + 图标控制。
- **生成设置**面板：发丝线分隔行、数字步进器、新输入框、蓝胶囊主按钮。
- **结果网格**：`ImagePickerGrid.tsx` / `AssetUploadGrid.tsx` / `ResultGallery.tsx` → Apple Photos 观感（大圆角缩略图、选中=蓝色描边+✓、状态小圆点、失败格特样）；`HoverZoomImage.tsx` 保留放大预览但容器 Apple 化。
- **任务队列**：`JobQueueTable.tsx` → `.data-table`（大写表头、等宽右对齐数字、状态胶囊、蓝色文字操作、行 hover 浅灰）。
- **分镜 / 场景参考**：`ShotSetPanel.tsx` / `SceneReferencePanel.tsx` → 卡片 + 可折叠组 Apple 化。
- **脚本 / 视频**：`ScriptPanel.tsx` / `VideoGenerationPanel.tsx` → 卡片与表格统一到新原语。
- **日志**：`LogDrawer.tsx` / `LogViewer.tsx` → 右侧抽屉容器 Apple 化；日志正文保留深色等宽终端观感（属于“代码/终端”语义，合理保留）。
- **模态**：场景参考 / 应用场景等弹窗 → Apple sheet（大圆角、磨砂遮罩、底部对齐动作）。
- 注：`SceneWorkspace` / `StoryboardWorkspace` / `LegacyProjectContent` 为 `page.tsx` 内联块（非独立文件），随页面一并改造。

### 6.5 深色图廊（Phase 4）
- 仅对**结果浏览全屏查看器与图片网格**（`ResultGallery` 全屏态等）引入一套**深色令牌**（近黑画布、图片为主、UI 隐形、状态用圆点），其余屏维持浅色。通过作用域类（如 `.theme-dark`）局部启用，不做全局深色。

---

## 7. 约束与非目标

- **纯视觉重构**：不改数据流、API、状态机、交互行为；所有控件、状态、文案（中文）、两套工作流（legacy / complex_product）功能保持不变。
- **不引入 UI 框架**：沿用 Tailwind v4 + 自定义工具类；唯一新增依赖是 `next/font` 字体（Inter / JetBrains Mono）与一个内联图标组件。
- **离线优先**：字体自托管（§3.3），不依赖运行时 CDN。
- **可访问性**：维持对比度（近黑 on 白达标）；可见焦点环（Apple 蓝）；图标按钮带 `aria-label`/`title`。
- **无回归**：不降低性能；保持响应式断点行为。

---

## 8. 落地节奏（已选 A：分阶段、先上线验证）

| 阶段 | 范围 | 价值 |
|---|---|---|
| **Phase 1** | 令牌+工具类（`globals.css`）+ 外壳（`layout.tsx`、`Header.tsx`）+ 首页（`page.tsx`）+ `Icon` 组件 | 共享类“一键换肤”全站；首屏可在真实 app 跑起来验证、纠偏 |
| **Phase 2** | 设置页 + `ProviderSettings` + 新建向导 | 低风险表单屏 |
| **Phase 3** | 工作台 `projects/[id]` + 其余约 14 个组件 | 核心、最密集，可再细分 3a 工具栏/标签/队列、3b 场景/分镜工作区、3c 结果网格 |
| **Phase 4** | 结果浏览 / 图库深色 | 图片屏体验升级 |
| 横切 | `Icon` 组件 + 逐处替换 emoji；新原语随用随建 | 贯穿各阶段 |

---

## 9. 已决与备注

- **Latin 替身字体 = Inter**：在 `-apple-system` 之后作为跨平台回退；Mac 仍得真 SF。选 Inter 是因为它是 SF 最接近、`next/font` 最稳的开源替身（用户在 Windows，实际看到的就是这个回退）。**可后续升级**为 Mona Sans / 官方 SF Pro（需自托管字体文件），不影响结构。
- **图标 = 自建内联 SVG 集**（不引图标库），保持轻量与 Apple 线性观感。
- **CJK 不打包重型字体**：依赖系统苹方/雅黑，保留 Noto Sans SC 兜底名；如日后要全平台统一中文观感，再评估自托管。

---

## 10. 验证方式

1. 启动：`npm run dev`（Windows：`npm run dev:win`），打开 `http://127.0.0.1:3000`。
2. 逐屏走查并与可视化稿对照（首页、设置、新建、工作台四标签、结果网格、任务队列、日志抽屉、各模态）。
3. 检查清单：字体离线生效；近黑/白对比达标；**全部控件与状态在位且功能不变**；7 态颜色正确；emoji 已清零；响应式正常；焦点环可见。
4. `npm run lint` 通过；构建 `npm run build` 通过。
