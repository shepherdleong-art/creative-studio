# 智能混剪贴纸实施计划

> 日期：2026-10-27
> 权威规格：`docs/superpowers/specs/2026-10-27-smart-mixcut-stickers-design.md`
> 执行方式：用户授权自主推进；只有重大方向变化或不确定风险再询问
> 当前阶段：C6 已完成；单条精准混剪贴纸首版进入批量支持评估

## 1. 实施原则

- 只扩展现有 HyperFrames overlay 管线，不修改 classic/1、冻结资产或其构建器。
- 首版只开放单条精准混剪，不开放批量贴纸 UI。
- 贴纸独立建模，不混入 `pointCues`；旧配置无需数据库迁移。
- 先打通静态贴纸的持久化、预览和真实导出，再增加编辑、动效和自动布置，避免最后才发现导出缺口。
- 缩略图只用于面板，原图只按实例需要加载；不引入 base64 或模板素材副本。
- 小浮窗使用 CSS 动画，根项目不新增 GSAP 依赖；正式 overlay 继续使用已有 GSAP 运行时。
- 每阶段完成针对性验证后提交并推送；直连失败时仅对单次命令使用本机代理，不修改 Git 配置。
- 当前交付状态：C1–C6 的代码与针对性验收已完成；首版仍只开放单条精准混剪，批量混剪贴纸需另行评估。

## 2. C1 — 素材目录、清单与缩略图

### 改动

- 新增 `scripts/build-sticker-assets.mjs`：通过显式 `--source` 接收 V3.1 素材目录，不硬编码开发机路径；复制 115 张原图到 `packaging/stickers/`，生成 `catalog.json` 和 WebP 缩略图。
- 新增 `app/api/packaging/stickers/[...path]/route.ts`：安全提供清单、缩略图和原图，拒绝越界路径及不支持格式。
- 新增 `scripts/packaging-stickers.test.ts`：验证数量、分类、共同 ID、RGBA、包围框、哈希和 `special` 规则。

### 验证

- 运行 `node scripts/packaging-stickers.test.ts`。
- 核对四套数量为 29/28/29/29，总计 115；28 个共同 ID 在四套均存在。
- 检查缩略图远小于原图，原始 PNG 字节及 SHA-256 与源清单一致。
- 检查 standalone 资源同步覆盖新增贴纸目录，不带入源机绝对路径。

### 提交

`feat: 接入四套贴纸素材与目录`

## 3. C2 — 独立领域模型与持久化

### 改动

- 新增 `lib/media-core/packaging-stickers.ts`：实例类型、默认值、模板映射、风格解析、19/48/144 帧常量、整帧与边界校验、动效常量。
- 修改 `lib/media-core/packaging-vars.ts`：包装 JSON 增加可选 `stickers`、`stickerDefaults`，旧数据缺省为空与 `follow-template`。
- 修改 `lib/final-edit/workspace.ts`：组级命令接受贴纸字段并做服务端校验，继续走串行 revision；历史恢复复用现有组级 revision 机制，不新建第二套历史。
- 修改 `lib/final-edit/packaging-cues.ts`：重写卖点时显式保留贴纸及默认设置。
- 在 `renderer.ts`、`worker.ts` 和包装任务入口提前补齐贴纸快照字段，旧快照缺省为空。

### 验证

- 新增领域测试，覆盖旧 JSON、非法帧、固定风格、共同 ID、`special` 和 revision 冲突。
- 运行 `node scripts/final-edit-packaging-vars.test.ts`、`node scripts/final-edit-packaging-cues.test.ts` 及相关 workspace 测试。
- 验证重新提取卖点和恢复文字版式不影响贴纸。
- 运行 `npx tsc --noEmit`。

### 提交

`feat: 增加贴纸领域模型与持久化`

## 4. C3 — 静态贴纸预览与真实导出闭环

### 改动

- 新增共享贴纸资源解析与 `packaging/stickers/runtime.js`：按有效包围框计算中心、视觉宽度、旋转、轨道层级和帧可见性。
- 修改包装预览路由与 `packaging-runtime.ts`，显式传递贴纸、默认设置和解析后的资产。
- 修改四个 overlay 模板，只挂载共享贴纸宿主和运行时；贴纸位于底片之上、包装文字之下，继续注册 `window.__timelines.overlay`。
- 修改 `packaging/package-video.mjs`：只复制快照实际使用的原图和共享运行时，校验路径与 SHA-256，缺失立即失败。
- 完成预览路由、renderer、worker、独立包装入口的字段透传，不开放源码工程 classic 输入。

### 验证

- 用静态实例完成至少一条真实导出，验证透明度、位置、开区间终点和预览一致。
- 检查四模板均使用同一运行时，未出现四套业务逻辑副本。
- 运行相关包装测试和 `npx tsc --noEmit`。
- `git diff --exit-code -- packaging/templates/classic lib/film-render` 确认冻结域零改动。

### 提交

`feat: 打通贴纸预览与导出渲染`

## 5. C4a — B+ 面板与预览编辑

### 改动

- 新增 `StickerPanel.tsx` 与 `StickerAnimationPopover.tsx` 壳；`PackagingCard.tsx` 只负责双页签集成。
- `PreviewStep.tsx` 管理贴纸选中、点击／拖放、空间草稿和命令提交。
- 新增独立贴纸编辑桥，不复用仅接受 `cover:`／`cue:` 或默认双击改字的卖点分支。
- 完成当前／全部风格、分类搜索、轻量缩略图、空间吸附、等比缩放、旋转和包装开关行为。

### 验证

- 新增浏览器测试，覆盖双页签、点击／拖放、选中联动、空间编辑、刷新恢复和旧项目。
- 检查面板不批量请求原图，窄窗口保持现有桌面三栏与横向滚动规则。

### 提交

`feat: 增加贴纸面板与预览编辑`

## 6. C4b — 时间轴、轨道层级与历史

### 改动

- 新增 `MixcutStickerTrack.tsx` 和纯时间轴辅助逻辑；`MixcutTimeline.tsx` 只接入轨道和共享状态。
- 实现整帧移动／修剪、可见磁吸、右键取消、复制删除、撤销重做。
- 实现轨道即层级、上下换轨、插入标线、目标高亮和半透明占位。
- 时间轴拖动只更新本地草稿，松开后一次提交。

### 验证

- 测试 24fps 起止、正文边界、轨道顺序、右键取消、一次撤销和复制后来源变化。
- 浏览器验证多贴纸重叠、双向选中及时间轴／预览一致。

### 提交

`feat: 增加贴纸时间轴与轨道层级`

## 7. C5a — 六种动效与轻量选择浮窗

### 改动

- 在共享 overlay 运行时实现 `soft/bounce/rise/slide/zoom/none`，动画完整限制在实例帧区间内。
- 实现短时长等比压缩、至少 1 帧入／退场和至少 2 帧稳定显示。
- 完成统一默认、应用全部、单张覆盖和模板推荐映射。
- 完成约 206px 浮窗：固定 `show/highlight` 示例图、六卡同时循环、关闭即停止；浮窗自身使用 CSS，不增加依赖。

### 验证

- 纯函数测试动画压缩和终点隐藏。
- 浏览器验证统一／单张设置、浮窗关闭、选择后实际贴纸播放一次。

### 提交

`feat: 增加贴纸组合动效与统一设置`

## 8. C5b — 一键 6 张基础布置

### 改动

- 新增 `lib/media-core/packaging-sticker-planner.ts`：注入随机源，落实分类抽取、144 帧门禁、三阶段、四模板六槽位。
- 实现自动组 ID、编辑标记、换一组、手动贴纸保留和原子撤销。
- 随机结果在命令提交时固定，预览和导出不再随机。

### 验证

- 固定随机源测试恰好 6 张、分类、无重复、帧边界和短视频门禁。
- 测试换一组只替换自动组、编辑提醒、复制自动贴纸变手动及一次撤销恢复。

### 提交

`feat: 增加一键基础贴纸布置`

## 9. C6 — 全量真实验收与交付记录

### 验证

- 新增贴纸渲染验收测试：四套模板真实导出，抽帧核对几何、透明度、层级、六种动效和终点。
- 验证 28 个共同 ID、`special`、跨风格固定、模板切换视觉尺寸保持。
- 运行相关现有包装、混剪和渲染测试；浏览器测试先阅读文件头并复用其启动方式。
- 运行 `npx tsc --noEmit`、`npm run lint`、`npm run build`。
- 检查 classic/1 与 `lib/film-render` 零变化，检查无 `.env`、数据目录或源机路径进入提交。

### 文档与提交

- 主执行文档 §1 更新状态，§4 追加实施编年史，§5 添加实际踩坑项。
- 设计规格标记验收结果。
- 提交 `test: 完成贴纸真实导出与回归验收`。
- 提醒用户单条版已基本验收，决定是否进入批量混剪贴纸阶段。

## 10. 回退与网络策略

- 每个 C 阶段独立提交；问题回退使用对应 `git revert`，不在共享工作区做破坏性重置。
- 本地始终使用 `master`。`origin` 为私有仓库 `ALANCL129/creative-studio`，推送 `master → master`；`shepherd` 为公开仓库 `shepherdleong-art/creative-studio`，固定推送 `master → dev`，不覆盖其 `master`。
- 两个远程都推送成功后才能宣称该阶段已交付；任一网络失败则明确记录“本地已提交、哪个远程待推送”。
- 需要代理时只对单次 push 使用 `git -c http.proxy=http://127.0.0.1:57890 ...`，不写 Git 全局或仓库配置。

## 11. 实施编年史与验收记录

- C1 `7f8cf19`：115 张原图、目录、缩略图与安全路由。
- C2 `5dd4e70`：独立实例模型、组级持久化、快照和包装历史。
- C3 `f655f75`：四模板共享宿主、真实透明层与 MP4 导出。
- C4a `07e58c2`：双页签素材库、点击/拖放与预览空间编辑。
- C4b `d6df726`：时间轴、轨道层级、右键取消、复制删除和统一撤销。
- C5a `82c6b06`：六动效、206px 浮窗、统一默认、单张覆盖和应用全部。
- C5b `f33ab30`：固定随机 6 张、三阶段与四模板槽位、换一组保护。
- C6：四套模板各完成 9 秒正式 MP4 + 透明 WebM；逐帧核对六动效、几何、透明度、终点、多层像素、`special` 与跨风格固定。28 个共同 ID 的模板映射和视觉尺寸保持通过。

针对性验证均通过：

- `node scripts/packaging-stickers-render.playwright.test.mjs`
- `node scripts/packaging-stickers-editor.playwright.test.mjs`
- `node scripts/packaging-stickers.test.ts`、`packaging-stickers-domain.test.ts`、`packaging-stickers-workspace.test.ts`、`packaging-sticker-timeline.test.ts`、`packaging-sticker-planner.test.ts`
- `node scripts/final-edit-packaging-vars.test.ts`、`final-edit-packaging-cues.test.ts`、`final-edit-packaging-palette.test.ts`
- `node scripts/final-edit-render.test.ts` 与现有混剪纯模型测试
- 变更文件 ESLint；`packaging/templates/classic` 与 `lib/film-render` 冻结边界零改动。

仓库既有基线阻塞（不记为贴纸验收失败，也不写成通过）：

- `npx tsc --noEmit` 与 `npm run build` 仍被 `packaging/film-builders` 既有缺失镜像文件及关联 `any` 错误阻断；Next 编译阶段成功，但构建未生成 `BUILD_ID`，因此未运行要求生产产物的 `final-edit-mixcut-real.playwright.test.mjs`。
- 全量 `npm run lint` 仍失败于既有 `packaging/asset-tools.cjs`、`process-assets.cjs` 和冻结第三方脚本；本次变更文件无 lint error。
- `final-edit-mixcut-flow.test.ts` 仍要求旧的空 `shotSetId` 形状门禁；当前实现已把可见性交由 `script-visibility`，该失败不由贴纸改动引入。
- `final-edit-mixcut-ui-contract.test.mjs` 缺少既有 `MixcutPanel.module.css`；`final-edit-mixcut.playwright.test.mjs` 缺少默认 Playwright 浏览器。贴纸真实 E2E 使用仓库内置 Chrome，已通过。

## 12. 实际踩坑与防坑

- 多键拖拽不能只监听 `pointerdown`：右键松开也可能触发同 pointerId 的 `pointerup`。贴纸时间轴只允许左键松开提交，并在右键或 `contextmenu` 时恢复草稿、短暂吞掉原生菜单。
- 动效入场首帧透明，普通选中必须落在稳定中点；“预览动效”才从起点播放，否则用户会误以为贴纸或编辑手柄消失。
- 相邻动效可共享同一帧作为前者终点和后者起点；验收必须按实例区域检查，不能把下一张的直接出现误判为前者拖尾。
- 正式 WebM 的缩放与 VP9 压缩会让单像素颜色漂移；层级验收使用多个高对比探测点的多数结果，不依赖单点颜色或 DOM z-index 数值。
- 时间轴播放头会覆盖贴纸块中点，浏览器测试从块内 25% 位置抓取，分别验证贴纸拖动和播放头拖动。
