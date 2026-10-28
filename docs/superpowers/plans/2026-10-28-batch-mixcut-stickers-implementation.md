# 批量混剪贴纸实施计划

> 日期：2026-10-28
> 权威规格：`docs/superpowers/specs/2026-10-28-batch-mixcut-stickers-design.md`
> 执行方式：用户授权自主推进；重大方向变化或不确定风险再确认
> 当前阶段：B7 已完成；功能、真实浏览器、四模板导出与生产构建验收通过，待双推

## 1. 实施原则

- 不新增数据表，不改批量迁移；贴纸继续保存在每条成片自己的包装 JSON。
- 复用 `media-core` 贴纸目录、规划器、时间轴、编辑桥和 HyperFrames 运行时，不复制第二套动画或渲染逻辑。
- 批量写操作必须按 `planId + outputVersionId + editRevision` 隔离；跨片复制与恢复均整体事务。
- 随机只在复制命令执行时发生，结果持久化后不再随机。
- 保持 v14 代码中已有的行筛选、眼睛预览、选择、审核和导出行为。
- 不修改 `packaging/templates/classic`、`lib/film-render` 或冻结构建资产。
- 每阶段先跑针对性测试，再提交并双推；网络失败明确记录待推送远程。

## 2. B1 — 规格与计划

### 改动

- 新增批量混剪贴纸设计规格与本实施计划。
- 记录指定批量统一审片 PRD／执行文档在工作树和 Git 历史中缺失的事实，不虚构条款。

### 验证

- 自查无 TBD／TODO、矛盾、双重数据源或未决范围。
- 核对工作区只包含本次文档。

### 提交

`docs: 定稿批量混剪贴纸设计`

## 3. B2 — 跨片变体规划器与领域校验

### 改动

- 新增 `lib/media-core/packaging-sticker-variants.ts`：
  - 区分手动、已编辑自动、未编辑自动实例。
  - 实现正文相对帧等比映射、19／20／144 帧约束。
  - 按来源阶段与阶段内次序重排未编辑自动实例。
  - 实现同类别素材抽取、跨目标使用计数、同阶段去重与池耗尽回退。
  - 在四模板安全槽位内随机中心点，保留尺寸、旋转和轨道。
  - 每张自动实例独立抽取五种可见动效。
  - 为每条目标生成新实例 ID、自动组 ID 和固定结果。
- 扩展批量包装保存校验：服务端按当前成片正文帧调用严格贴纸校验，非法数据直接拒绝。
- 新增 `scripts/packaging-sticker-variants.test.ts` 与批量包装边界测试。

### 验证

- 固定随机源覆盖完整六张、部分自动组合、不同目标时长、纯手动复制和短视频。
- 验证来源已删除实例不补回、已编辑自动按手动映射、目标其他字段不变。
- 验证跨片尽量不同、同阶段不重复、池耗尽可终止、动效只来自五种可见预设。
- 运行 `node scripts/packaging-sticker-variants.test.ts` 及既有贴纸领域／规划器测试。

### 提交

`feat: 增加批量贴纸变体规划器`

## 4. B3 — 批次事务命令与整体历史后端

### 改动

- 新增 `lib/batch-production/sticker-copy.ts`：读取来源与目标当前谱系，在一个 SQLite 事务内完成校验、规划、写入、修订递增与审核清除。
- 新增 `app/api/batch-production/batches/[id]/outputs/sticker-copy/route.ts`：接收复制与多片包装恢复请求，统一输入校验、无缓存响应和错误映射。
- 支持目标空集、重复、来源自复制、跨批次、包装关闭、不可编辑、版本冲突和时长不足的整体拒绝。
- 支持多目标包装前后快照的整体撤销／重做；任一冲突时零写入。
- 新增 `scripts/batch-sticker-copy.test.ts`，使用内存数据库与临时数据根。

### 验证

- 双目标全部成功；任一目标冲突时所有目标保持原字节与审核态。
- 只修改目标 `stickers / stickerDefaults`，来源及其他成片字段不变。
- 整体撤销／重做恢复所有目标，冲突时不存在部分恢复。
- 运行相关 `output-arrangement`、审核和批量工作区测试。

### 提交

`feat: 增加批量贴纸事务复制`

## 5. B4 — 当前成片贴纸编辑器

### 改动

- 在 `BatchPackagingEditor` 内接入“包装设置／贴纸”双页签，复用 `StickerPanel` 与动效浮窗。
- 扩展批量统一审片选择模型，增加 `sticker` 目标及所属 `planId`；切片时清理无效选择和草稿。
- 扩展 `BatchPackagingOverlay` 与共享 `PackagingOverlay`，支持贴纸选中、空间提交、删除、空白取消选中和动效播放。
- 在批量时间轴每个包装开启的成片行接入贴纸轨道，复用中文标签、固定区分色、移动／修剪／换轨、磁吸和右键取消。
- 单片修改继续走 `set_packaging` 与现有单片历史；自动布置、应用全部和换一组只影响当前片。

### 验证

- 浏览器覆盖点击／拖放、预览空间编辑、删除、双向选中、时间轴操作、六动效和自动布置。
- 连续切片不串选中、草稿或忙碌状态；包装关闭保留数据。
- 运行单条贴纸编辑器回归，确认共享组件未破坏单条行为。

### 提交

`feat: 接入批量成片贴纸编辑`

## 6. B5 — 跨片复制弹窗与整体历史交互

### 改动

- 新增独立复制弹窗组件，不把目标选择与随机算法塞入面板。
- 默认勾选时间轴已选有效目标，支持全选有效、清空、逐项选择和无效原因展示。
- 显示已有贴纸替换与已审核重审提示；提交期间防重复，成功后刷新全部目标。
- 扩展批量历史项为单片／多片联合类型；多片项一次撤销／重做，冲突时按最新状态刷新并清空失效历史。

### 验证

- 浏览器验证默认目标、手动改选、无效排除、替换提示、实际复制和刷新持久化。
- 验证多片一次撤销／重做，以及后续编辑导致冲突时无部分恢复。

### 提交

`feat: 增加跨片贴纸变体复制`

## 7. B6 — 批量预览与正式渲染闭环

### 改动

- 扩展 `lib/media-core/packaging-preview.ts`：注入贴纸、默认动效、解析资产与贴纸编辑桥。
- 扩展 `lib/media-core/packaging-render.ts`：从调用方快照读取贴纸并解析实际 PNG，交给同一 `package-video.mjs`。
- 核对 `batch-renderer.ts`、导出编排和任务快照白名单，确保冻结贴纸字段，不在 worker 重新随机。
- 素材缺失或哈希异常在导出前明确失败；无贴纸旧任务保持原行为。

### 验证

- 预览和导出读取同一实例；片头 20 帧无贴纸，终点无拖尾。
- 两条不同时长目标完成真实导出，四模板验证素材解析与透明叠加。
- 已排队任务后再次编辑，旧任务产物仍按原快照。
- 运行批量渲染、包装预览和单条贴纸渲染回归。

### 提交

`feat: 打通批量贴纸预览与导出`

## 8. B7 — 全量验收与交付

### 验证

- 运行新增领域、API、浏览器和真实渲染测试。
- 运行既有单条贴纸、批量包装、审核、字幕、封面和导出相关测试。
- 运行变更文件 ESLint、`npx tsc --noEmit`、`npm run lint`、`npm run build`。
- `git diff --exit-code -- packaging/templates/classic lib/film-render` 验证冻结域零改动。
- 检查无 `.env`、数据目录、日志、密钥或源机绝对路径进入提交。

### 文档与提交

- 更新本计划当前阶段与实施记录；规格标记验收结果。
- 提交 `test: 完成批量贴纸真实导出与回归验收`。
- 双推 `origin/master` 与 `shepherd/dev`，报告真实测试和推送结果。

## 9. 回退与网络策略

- 各 B 阶段独立提交；回退使用对应 `git revert`，不做破坏性重置。
- 本地使用 `master`；`origin` 推 `master → master`，`shepherd` 推 `master → dev`。
- 两个远程都成功后才能宣称阶段已双推；任一失败则保留本地提交并明确待推送项。
- 需要代理时只对单次 push 使用命令级代理，不修改 Git 配置。

## 10. 实施记录与验收结果

- B1 `b5f0bdb`：批量贴纸设计规格与实施计划。
- B2 `2e4abab`：跨片变体规划器、随机去重、时间映射与批量保存帧校验。
- B3 `55235b3`：批次事务复制、多片恢复、修订与审核门禁。
- B6 `4d14987`：批量预览与正式渲染贴纸数据闭环；`3782e06` 增加四模板真实导出验收。
- B4 `35c9956`：当前成片双页签、预览空间编辑、时间轴、拖放和动效播放。
- B5 `f5fc510`：跨片目标弹窗、事务 API 与多片整体撤销／重做。
- B7 `a1f64df`：修复预览切回时间轴后的 Delete 焦点，并完成真实浏览器回归。

已通过：

- `node scripts/packaging-sticker-variants.test.ts`
- `node scripts/batch-sticker-copy.test.ts`
- `node scripts/batch-packaging-stickers.test.ts`
- `node scripts/batch-stickers-editor.playwright.test.mjs`：9 次核心真实写入、488 条真实 API 响应，API 失败、页面异常及 console error 均为 0。
- `node scripts/batch-sticker-render.test.ts`：四模板、6s／9s 正文、29 个正文贴纸稳定帧区域、片头安全区域与同快照字节一致。
- `node scripts/packaging-stickers-editor.playwright.test.mjs`：单条贴纸完整回归。
- 既有贴纸领域、规划器、时间轴、workspace、包装变量／卖点／配色测试。
- 变更文件 ESLint、`npx tsc --noEmit --pretty false`。
- `npm run build`：生产构建及 standalone 资源同步通过，保留 2 条既有 NFT 非阻断警告。
- `git diff --exit-code -- packaging/templates/classic lib/film-render`：冻结域零改动。

非阻断既有基线：

- 全量 `npm run lint` 仍有 59 个历史 error 与 1206 个 warning，集中于第三方包装脚本和历史 `require()`／`this` 别名；本次变更文件 lint 无 error。
- `batch-renderer.test.ts` 仍引用已不存在的历史导出 `regenerateBatchOutputCover`，因此在模块加载阶段失败；本功能使用独立真实 `renderBatchOutputVersion` 验收，未把该历史漂移记为通过或本次回归。
