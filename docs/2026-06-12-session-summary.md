# 2026-06-12 会话总结：Apple 风格 UI 改版

## 目标

把「批量图片编辑工作台」全站 UI 从通用 Tailwind 默认观感改为 **Apple（apple.com.cn）精致极简风格**——纯视觉重构、不改任何功能。

## 设计探索

1. **可视化方向比较**（brainstorming visual companion，启动本地服务 `localhost:50246`）：
   - 淘汰：暖纸编辑（"太 Claude"——暖米底+衬线+陶土色）、瑞士极简（"太寡淡"）、深色画廊（"可视度低"）
   - 第二轮：薄荷/天青/珊瑚——仍不对味
   - **最终锁定：Apple 风格**（用户给了 apple.com.cn 参考）

2. **可视化验证**：用真实工作台内容做了 Apple 风格首页 + 工作台 mockup，用户确认。

3. **落地节奏：选 A**——分阶段、先上线验证。

## 产出文档

| 文件 | 说明 |
|---|---|
| `docs/2026-06-12-workbench-ui-apple-redesign-design.md` | 设计规格（令牌/原语/各屏方案/约束/节奏） |
| `docs/2026-06-12-workbench-ui-apple-redesign-plan.md` | Phase 1 详细实现计划 + Phase 2–4 路线图 |

## 实现过程

### 执行模式

- **Phase 1：** Codex（`codex exec`）作为子代理，我逐任务审查（`git diff` + `tsc` + `lint` + 构建）。
- **Phase 2–3：** Codex 额度用完后切换为 Claude Agent（`Agent` 工具），同样逐任务审查。

### Phase 1 — 设计系统 + 外壳 + 首页 + Icon（6 个任务）

| 提交 | 内容 |
|---|---|
| `7927c40` | 设计令牌 + 共享工具类（`globals.css`） |
| `39ce5e9` | 字体 + 外壳（`layout.tsx`） |
| `4eaf330` | Icon 线性图标组件（17 种，替代 emoji） |
| `cefb070` | 磨砂导航 Header |
| `e6a7cf2` | 首页 Apple 重写 |
| `270f54c` | **关键修正：弃用 `next/font/google`，改纯系统字体栈** |

#### 字体策略修正

构建环境（Windows）无法连接 `fonts.googleapis.com`，`next/font` 下载失败并静默回退，离线 `npm run build` 亦有失败风险。最终采用纯系统字体栈：
- `-apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", "Segoe UI", "Noto Sans SC"`
- Mac 得真 SF + 苹方；Windows 用 Segoe UI + 微软雅黑
- 离线 `npm run build` 验证通过

### Phase 2 — 设置页 + 新建向导 + 全局 token sweep

| 提交 | 内容 |
|---|---|
| `4540a41` | 设置页、ProviderSettings、新建向导 Apple 化 |
| `7f7f43a` | **Phase 3 bonus：全站 14 组件 token sweep**（Agent 超出指派范围，但改动正确——旧 `text-gray-*`/`border-gray-*`/`bg-blue-*` → Apple token，为 Phase 3 铺路） |

### Phase 3 — 工作台核心

| 提交 | 内容 |
|---|---|
| `11a4b41` | 工作台页 `projects/[id]/page.tsx`：磨砂工具栏 + 段控标签 + Apple sheet 模态 + 队列条 + 全局 token 替换；`LogDrawer` + `SceneReferencePanel` 收尾 |

## 改动统计

- **5 个页面：** `layout.tsx`、`page.tsx`（首页）、`settings/page.tsx`、`projects/new/page.tsx`、`projects/[id]/page.tsx`
- **16 个组件：** Header、Icon、ProviderSettings、ImagePickerGrid、ImageUploader、AssetUploadGrid、ProjectWorkbenchTabs、LogDrawer、LogViewer、HoverZoomImage、ShotSetPanel、ResultGallery、JobQueueTable、SceneReferencePanel、ScriptPanel、VideoGenerationPanel、PromptEditor
- **新增：** `components/ui/Icon.tsx`（17 种线性 SVG 图标）
- **设计系统：** `app/globals.css` 完整重写（`@theme` 令牌 + `@layer utilities` 原语）
- **文档：** 2 个 spec/plan 文件 + 本会话总结

## 设计语言摘要

- **配色：** `#FFFFFF` / `#F5F5F7` / `#1D1D1F` + Apple 蓝 `#0071E3`（仅强调）
- **字体：** 系统栈（离线安全）
- **形状：** 胶囊按钮（`980px`）、大圆角卡片（`18px`）、发丝线边框
- **图标：** 细线 SVG（SF Symbols 观感），emoji 清零
- **动效：** 磨砂导航、卡片 hover 微浮、Apple 蓝焦点环
- **模态：** Apple sheet（磨砂遮罩 + 大圆角 + 强阴影）

## 未完成

- **Phase 4：** 结果浏览 / 图库深色模式（`.theme-dark` 作用域，待后续）

## 分支

`feat/apple-ui-redesign`（已 push 至 `origin`）
