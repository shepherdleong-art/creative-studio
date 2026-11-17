# 贴纸与正文卖点自动布局 v2 实施计划

> 迁移说明（2026-11-17）：本文为旧分支的实施记录归档，历史完成项、测试结果和执行授权不代表当前迁移状态。本次工作从最新 main 独立迁移布局功能，实际修复与验收见 `docs/2026-11-17-贴纸2.0独立迁移与验收.md`。

> 日期：2026-11-13
> 权威规格：`docs/superpowers/specs/2026-11-13-packaging-auto-layout-v2-design.md`
> 执行方式：用户授权直接实施，不再逐阶段确认
> 当前阶段：P0–P8 已完成；2026-11-17 后续修复、验收与接手状态见第 13 节

## 1. 实施原则

- 不新增数据库表或迁移，版本、Resolution 和 manifest 身份随现有包装 JSON、批量快照和任务快照保存。
- 不把需求简化成修改静态槽位；所有 v2 自动候选必须经过规范布局服务预检和原子提交。
- 单条与批量复用 `media-core` 和共享 HyperFrames 运行时，不建立第二套媒体、字体或渲染实现。
- 保持 v14 统一审片行为、现有审核门禁、包装开关和跨片事务语义。
- classic/1、`lib/film-render` 和 classic 构建资产保持冻结。
- 每阶段先补失败测试，再实现并运行同名测试；旧 v1 路径必须有回归证据。
- 不提交或推送 Git，除非用户后续明确要求。

## 2. P0 — 规格、计划与基线

### 已完成

- 写入设计规格与本计划，完成占位符、矛盾和格式自查。
- 工作区在开始前干净，Node v24.16.0 可用。
- 以下基线通过：
  - `node scripts/packaging-sticker-planner.test.ts`
  - `node scripts/packaging-sticker-variants.test.ts`
  - `node scripts/batch-sticker-copy.test.ts`
  - `node scripts/packaging-stickers-domain.test.ts`
  - `node scripts/packaging-stickers.test.ts`
  - `node scripts/packaging-sticker-timeline.test.ts`
  - `node scripts/packaging-stickers-workspace.test.ts`
  - `node scripts/batch-packaging-stickers.test.ts`
  - `npx tsc --noEmit --pretty false`

## 3. P1 — 版本、位置语义与领域契约

### 改动

- `lib/media-core/packaging-stickers.ts`
  - 为自动来源增加 `layoutVersion`、`positionPinned`。
  - 保留 v1 缺省语义，严格拒绝不支持的版本。
  - 增加“以解析中心原子固定并应用编辑补丁”的纯领域入口。
- `lib/media-core/packaging-vars.ts`
  - 增加 `pointCuesLayoutVersion`、`layoutRuntimeBundleVersion` 和 `LayoutResolution` 类型、清洗与严格边界校验。
  - 保留旧配置兼容；未知版本不得静默降级。
- 新增 `lib/media-core/packaging-auto-layout.ts`
  - 定义生成原因、Resolution、候选 payload、input hash、pending/stale 的领域类型与纯函数。
  - 统一可移动集合、固定集合和 mixed bundle 判定。
- `lib/media-core/packaging-sticker-planner.ts`
  - 新自动实例写入 v2 和未固定状态；v2 开头/中段使用上方基准槽位，结尾槽位逐值保持。
- `lib/media-core/packaging-sticker-variants.ts`
  - 仅未编辑自动实例生成新 v2；手动和已编辑实例保留实际中心与原版本语义。
- `lib/media-core/packaging-cues.ts`、`lib/batch-production/packaging.ts`
  - 显式区分 initial、explicitReextract、automaticRebuild、derivedVersion，只有规格允许的原因可升级版本。

### 测试

- 扩展 `packaging-stickers-domain.test.ts`、planner、variants、workspace 和批量包装测试。
- 新增 `packaging-auto-layout.test.ts` 覆盖版本组合、位置固定、候选 rebase 和未知版本。

### 验收

- 旧 JSON 字节语义与 v1 默认行为不变。
- 点击素材新增仍创建手动居中实例。
- 非位置编辑若缺少 resolvedCenter 必须零写入。
- 自动 hash 重建和既有 output version 派生不得升级 v1。

## 4. P2 — 共享布局核心与 Canonical Layout Service

### 改动

- 新增 `packaging/auto-layout/runtime.js`
  - 共享 VisualBox、模板外扩、实际输出画幅换算、24fps 可见性和 GSAP 帧采样。
  - 实现固定—固定豁免、三阶段紧凑搜索、MRV、前向检查、稳定 ID 决胜。
  - 区分 `infeasible` 与 `budget_exceeded`，不返回未验证位置。
  - 导出纯函数供 Node 领域测试。
- 新增 `packaging/auto-layout/host.html` 与 `packaging/layout-service.mjs`
  - 建立 layout-only 宿主，不渲染底片视频。
  - 统一字体、图片 decode、fit、ResizeObserver、布局 ready 和操作 generation。
  - 复用现有 HyperFrames/Chrome 解析与离线运行资源，不引入另一套浏览器依赖。
- 新增 `lib/media-core/packaging-auto-layout-service.ts`
  - 在 `dataRoot()` 下创建受控临时工作区，调用共享 runtime，校验并返回 LayoutResolution。
  - 支持取消、进程异常清理、输入输出哈希和资源身份校验。
- 三种画幅使用规格中的 `s`、间距、网格、epsilon 和量化契约。

### 测试

- 新增 `packaging-auto-layout-runtime.test.mjs`：数值、帧、外扩、固定集合、搜索和确定性。
- 新增 `packaging-auto-layout-service.test.ts`：真实字体/图片、ready、取消、三画幅与错误分类。
- 固定随机输入重复解析结果完全一致；播放和 seek 不触发重新求解。

## 5. P3 — 四模板与规范预览接入

### 改动

- `packaging/templates/overlay-{poster,journal,minimal,variety}/index.html`
  - 保留 legacy/v1 路径。
  - v2/mixed 使用 Resolution 中全部正文元素的 fit 与几何，不再独立 refit 出第二套结果。
  - 所有字体回调、延时 refit 和 ResizeObserver 进入唯一布局管线。
- `packaging/stickers/runtime.js`
  - 未固定 v2 使用 resolvedCenter；固定、v1 和结尾元素保持各自位置语义。
  - 编辑桥读取实际解析中心，布局 ready 前不发布完成态时间线。
- `lib/media-core/packaging-preview.ts`、`packaging-runtime.ts`
  - 注入版本、Resolution、manifest 和规范资源，保留无贴纸旧配置兼容。
- `app/api/final-edit-groups/[id]/packaging-preview/route.ts`
- `app/api/batch-production/batches/[id]/outputs/[planId]/packaging-preview/route.ts`
  - v2 只发布有效 Resolution；stale/unresolved 返回可区分状态。
- 新增单条 `packaging-layout` 与批量 output `packaging-layout` API，承担候选预检、draft 重试和 revalidate，不把大段浏览器逻辑复制到 UI。

### 测试

- 扩展 `batch-packaging-stickers.test.ts` 与包装预览测试。
- 新增 mixed bundle 的全正文几何测试，覆盖固定元素 fit。
- 验证字体回调、延时 refit 和 RO 不会覆盖避让结果。

## 6. P4 — 单条命令、手动恢复与并发状态

### 改动

- `lib/final-edit/workspace.ts` 与组级命令 API
  - 自动命令捕获 group/variant、expectedRevision、preInputHash、clientOperationId。
  - CLS 后按修订和输入哈希 CAS，配置、Resolution 和 manifest 同事务提交。
  - 自动 hash 重建失败保留恢复现场但标记 stale，禁止冒充当前结果导出。
- `components/mixcut/PreviewStep.tsx`、`StickerPanel.tsx`、`MixcutTimeline.tsx`、`MixcutStickerTrack.tsx`
  - 一键布置和换一组改为候选预检命令。
  - 所有自动贴纸编辑先取得 resolvedCenter 并原子 pin；缺坐标零写入。
  - 实现 commandPending、revalidatePending、取消、迟到响应淘汰和中文错误。
- `components/packaging/PackagingOverlay.tsx`、共享编辑桥
  - 手动拖动使用实际解析位置，固定后允许任意位置。
- 实现失败 draft 的不可变 candidatePayload、compatibility 检查和不重抽 rebase。
- 手动移动、删除和禁用包装先保存用户结果，再后台 revalidate；全固定走 fixed-only。

### 测试

- 扩展 `packaging-stickers-workspace.test.ts` 和单条 Playwright 测试。
- 覆盖动画、修剪、换轨、风格修改不跳位，慢响应不覆盖新修订。
- 覆盖手动 stale 恢复、禁用包装取消 pending、全固定重叠可导出。

## 7. P5 — 批量、跨片预检与整体历史

### 改动

- `lib/batch-production/output-arrangement.ts`、`packaging.ts`
  - 批量自动命令和版本派生接入统一 CAS、Resolution 和 stale 语义。
- `lib/batch-production/sticker-copy.ts`
  - 将随机规划移至事务外，冻结来源与全部目标完整输入哈希。
  - 每目标调用 CLS layout-only 预检。
  - 事务内同时重验来源和目标 IDs/revisions/inputHash/manifestHash。
  - Resolution、manifest 和 candidate 身份进入 before/after 快照及整体撤销重做。
- `app/api/batch-production/batches/[id]/outputs/sticker-copy/route.ts`
  - 支持预检失败、CAS 冲突和 candidate rebase 的稳定错误映射。
- `components/batch-production/BatchStickerPanel.tsx`、`BatchPackagingEditor.tsx`、`review/`
  - 接入两类 pending、失败 draft、目标级中文诊断和恢复操作。
  - 保持 v14 行筛选、眼睛预览、选择、审核和导出契约。

### 测试

- 扩展 `batch-sticker-copy.test.ts`、`batch-stickers-editor.playwright.test.mjs`。
- 注入预检期间来源变化、任一目标变化、manifest 变化，均整批零写入。
- 多目标一次撤销重做恢复同一 Resolution，不重新随机。

## 8. P6 — 资源冻结、正式导出与发布门禁

### 改动

- 新增 `lib/media-core/packaging-layout-manifest.ts`
  - 记录实际输出尺寸、runtime bundle、Chromium 版本/平台/架构/分发哈希、GSAP、模板、fit、字体、贴纸 PNG 和 Alpha 几何哈希。
  - 物化 v2/mixed 资源到 `dataRoot()` 下的受管内容寻址目录。
- `lib/media-core/packaging-render.ts`、`packaging/package-video.mjs`、`render-overlay.mjs`
  - 只读取任务 manifest 和物化资源。
  - 等待布局 ready，发布前逐帧验证 Resolution。
  - 缺失字体、图片、runtime、引擎或哈希不匹配全部 fail closed。
- `lib/final-edit/worker.ts`、`lib/final-edit/packaging.ts`
  - v2 在封面发布前完成布局验证，避免半套正式产物。
- `lib/batch-production/batch-renderer.ts`、导出编排和 preflight
  - 在整片任务与正式发布前验证版本、Resolution 和 manifest。
- `scripts/sync-standalone-assets.mjs` 与打包守护
  - 纳入共享布局运行时和受管引擎资源，不禁入用户数据。

### 测试

- 扩展 `batch-sticker-render.test.ts`、单条渲染、导出 preflight 和打包边界测试。
- 验证旧 v1 路径不变，v2 不使用执行时新目录替代冻结资源。
- `git diff --exit-code -- packaging/templates/classic lib/film-render`。

## 9. P7 — 三画幅四模板全量验收

### 领域与并发

- 运行全部贴纸、包装、批量复制、workspace、审核和导出相关测试。
- 覆盖四模板、三画幅、全部自动素材、六动效、混合版本、固定—固定重叠和失败 draft。
- 覆盖单条/批量慢请求、取消、崩溃恢复和来源/目标 CAS。

### 浏览器

- 运行单条与批量贴纸 Playwright 回归。
- 验证上 40%、紧凑避让、位置不跳变、手动任意位置、stale 恢复和禁用包装。
- 验证失败候选修正障碍后按原随机 payload 重试。

### 真实导出

- 四模板分别覆盖 1080×1440、1080×1920、1920×1080。
- 使用不同时长正文，检查所有可见帧、片头 20 帧、层级和终点。
- 验证预览与正式导出使用同一 Resolution 和 manifest。
- 验证封面与视频发布前门禁及旧冻结任务兼容。

### 工程检查

- `npx tsc --noEmit --pretty false`
- 变更文件 ESLint
- `npm run build`
- 冻结域 diff 和打包禁入清单检查
- 全量 lint 与历史漂移只如实记录，不伪报通过

## 10. P8 — 文档与交付

- 更新 `docs/reference/视频包装.md`：版本、Resolution、CLS、手动固定、pending、资源冻结与测试入口。
- 更新 `docs/reference/批量生产模块.md`：跨片双侧 CAS、预检 manifest、历史和发布门禁。
- 在本计划记录真实测试、三画幅导出结果、未通过的历史基线和剩余限制。
- 检查无密钥、用户数据、临时媒体、日志或本机绝对路径进入变更。

## 11. 高耦合顺序控制

- P1 未稳定前不改模板，避免反复迁移字段。
- P2 的 CLS 输入输出契约未通过真实字体/图片测试前，不接 UI 命令。
- P3 与 P4/P5 可使用同一 Resolution 接口推进，但命令提交必须等各自 CAS 完成。
- P6 未完成前不得宣称正式导出闭环，即使浏览器预览已经正确。
- 每阶段保持 v1 可用；v2 失败只能影响相关包装的完成态预览和导出，不能阻塞不依赖新结构的项目功能。

## 12. 最终验收记录

### 已通过

- 领域与并发回归：
  - `packaging-auto-layout.test.ts`、`packaging-auto-layout-runtime.test.mjs`。
  - `packaging-sticker-planner.test.ts`、`packaging-sticker-variants.test.ts`、`packaging-stickers-domain.test.ts`、`packaging-sticker-timeline.test.ts`、`packaging-stickers.test.ts`。
  - `packaging-stickers-workspace.test.ts`、`batch-packaging-stickers.test.ts`、`batch-sticker-copy.test.ts`；覆盖 v2 预检、来源/目标并发修改零写入和 Resolution 整体撤销重做。
- `packaging-auto-layout-service.test.ts`：四套当前模板 × 1080×1440、1080×1920、1920×1080 的真实 Chrome 测量、求解与逐帧复测全部通过；冻结资源篡改和 stale 导出均被阻断。
- `packaging-auto-layout-render.test.ts`：真实 FFmpeg + HyperFrames 导出通过；移走在线模板和重放器后，v2 仍只凭冻结副本生成 MP4/JPG，正文包装像素位于上 40%。旧版四模板真实 MP4 回归也已通过。
- `packaging-stickers-editor.playwright.test.mjs`：最终复跑通过，覆盖素材目录、空间编辑、时间轴与历史、六动效、自动 6 张/换一组、实际播放、包装开关与刷新恢复。
- `batch-stickers-editor.playwright.test.mjs`：批量真实浏览器回归通过；最终记录为 568 条真实 API 响应、0 页面异常、0 失败响应。
- `npx tsc --noEmit --pretty false` 通过。
- 变更文件 ESLint 为 **0 errors / 3 warnings**；警告是两个既有 `<img>` 用法和 `renderer.ts` 既有未使用 `sharp` 导入，本次没有新增 lint 错误。
- `npm run build` 通过，standalone 静态资源同步和构建内禁入断言通过；Turbopack 仍输出 3 条既有 NFT 动态路径警告，不阻断构建。
- `windows-portable-payload.test.mjs` 与 `python-runtime-windows.test.mjs` 通过。
- `git diff --check` 通过（仅 Git 行尾转换提示）；`git diff --exit-code -- packaging/templates/classic lib/film-render` 通过，冻结域无差异。

### 既有基线问题（不作为本次通过项）

- 全量 `npm run lint` 仍为 **3498 problems（191 errors / 3307 warnings）**；变更文件单独检查无错误，不把全量历史问题记为本次回归。
- `final-edit-workspace.test.ts` 在未改动的 `assetsForScript` 查询处失败：`SqliteError: no such column: displayName`，属于既有测试 schema 漂移。
- `standalone-desktop-boundary.test.mjs` 的临时 fixture 未复制 `scripts/packaging/forbidden-paths.json`，在调用同步脚本时以 ENOENT 退出；真实 `npm run build` 的同步与禁入断言已通过。
- `windows-installer.test.mjs` 仍读取已不存在的 `desktop/service.ts`，未进入后续断言。
- `company-provider-startup.test.mjs` 为 16/21 通过；其余 5 项仍断言旧 PowerShell 实现（如 `$stackFile`、`Get-FileHash`、`ExecutablePath`）或缺少临时 `scripts/runtime/ports.mjs` fixture。上述脚本和测试均未被本次改动触碰。

### 交付边界

- 常驻参考已同步更新：`docs/reference/视频包装.md` 与 `docs/reference/批量生产模块.md`。
- 变更仅限自动布局、包装预览/导出、单条/批量命令、跨片事务、测试和对应文档；未提交或推送 Git。
- 最终 `git status` 只包含上述预期源码、测试与文档，没有密钥、本机数据库、用户素材、日志、临时媒体或导出产物进入变更。

## 13. 2026-11-17 后续缺陷修复与接手状态

### 需求边界再次确认

- 只有今后新生成的自动布局使用新规则；旧成片、手动元素、已编辑自动元素和已冻结导出快照不得被静默改位。
- 开头／中段自动贴纸及自动正文卖点约束的是**完整可见外框**位于上 40%，不是只看中心点；结尾两张固定下半部 62%／72%。
- 预览、撤销重做、跨片复制和正式导出继续读取同一份持久化 Resolution，不得重新随机。

### 本轮实际修复

1. `packaging/auto-layout/replay.js` 分开处理输出画布 `px` 与手账 `cqw` 字号；模板资源路由接受 `.ttc`，修复卖点异常放大、缩小到不足 1px 和用户字体回退。
2. `packaging/auto-layout/runtime.js` 的第一阶段提前返回同时检查卖点重叠与当前完整外框是否越界；求解改为“贴纸小幅求解 → 固定贴纸只解卖点 → 必要时全量联合”，避免手账多卖点进入大搜索树。
3. `packaging-sticker-planner.ts` 四模板结尾槽位统一为 62%／72%，保留左右错落、宽度、旋转和随机素材语义。
4. 手账可见外框可相对模板锚点偏移，但锚点必须夹在画布 0–100% 内。此前负百分比导致 `sanitizePackagingLayoutResolution` 丢弃整份结果并回退旧 `stale`，不是浏览器覆盖或空间不足。
5. 单条布局命令与工作区 CAS 仍严格校验用户 revision 和全部包装内容，但允许仅派生 `layoutResolution` 在计算期间变化，修复后台 revalidate 与显式换一组之间的伪 409。
6. 内容寻址资源发布在 Windows 只对 `EPERM/EEXIST/ENOTEMPTY` 做有限 rename 重试，且必须看到完整 `manifest.json` 才接受成功；其他错误与最终失败仍 fail closed。

### 本轮真实验收

- 通过：`packaging-auto-layout-runtime.test.mjs`、`packaging-sticker-planner.test.ts`、`packaging-stickers-workspace.test.ts`。
- 通过：`packaging-auto-layout-service.test.ts` 的四模板 × 三画幅真实 Chrome；每个结果同时通过持久化 schema，卖点完整外框不越出上 40%，结尾保持 62%／72%。
- 通过：`batch-stickers-editor.playwright.test.mjs`，最终为 **937 条真实 API 响应、0 API 失败、0 页面异常、0 console error**；覆盖四卖点、px/cqw、TTC、结尾位置、换一组、跨片复制和整体历史。
- 通过：`packaging-stickers-editor.playwright.test.mjs`，覆盖单条自动 6 张、结尾 62%／72%、换一组、时间轴、动效、撤销重做和刷新恢复。测试等待器只匹配 `operation=auto-stickers`，不得把后台 `revalidate` 响应当成按钮结果。
- 通过：`npx tsc --noEmit --pretty false`、本轮变更文件 ESLint（0 输出）、`git diff --check`（只有行尾转换提示）和 `npm run build`。本次构建只有 `next.config.ts` 经 upload route 引入的一条既有 NFT 动态路径警告。
- 实际项目执行换一组后得到 6 张新自动贴纸并保留 3 张手动贴纸，Resolution 为 resolved；抽查前段自动贴纸完整外框为 16.3%–29.4%，自动卖点为 31.7%–36.3%，结尾为 62%／72%，手动位置未变。
- 本轮没有重新执行完整的 `packaging-auto-layout-render.test.ts` 四模板真实导出矩阵；既有导出结果见第 12 节。如下个任务触及渲染、冻结资源或发布，先补跑该测试与对应打包边界，不得把本轮浏览器验收写成导出矩阵已重跑。

### 下一个 agent 的接手入口

- 先读 `AGENTS.md`、`docs/reference/视频包装.md` 和本计划；批量跨片或统一审片改动另读 `docs/reference/批量生产模块.md`，桌面启动问题读 `docs/reference/打包与桌面运行.md`。
- 当前全部 v2 源码、测试和文档变更仍在工作区，**没有 Git 提交或推送**；不要误把上一轮提交当作包含本轮修复。
- Windows 改生产构建前先完全退出桌面，避免 `.next/standalone` 的 sharp 原生模块被锁；构建后再启动。
- 桌面验收必须同时确认本次 `electron-service.json` 的 instanceId/origin、对应 `/api/desktop/health` 和真实窗口可进入。端口是随机 loopback，不得沿用旧端口，也不能只凭 `npm run dev:desktop` 的启动日志宣称成功。
- 临时 Playwright fixture 与本机数据库只用于排查，不应进入 Git、文档附件或安装包。
