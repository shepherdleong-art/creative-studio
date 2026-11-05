# 05 H3 和 Wan 自动模式

**状态：** `ready-for-human`

**依赖：** 04 完成定向验收。

## 目标与必读

实现 [规格 §6](../../specs/2026-11-05-团队模板与视频工作流修复-功能方案.md)，不增加人工模式切换。先读供应商与队列、公司网关与 COS 两份 reference。

## 代码入口

- `lib/video-generation-options.ts` 的选择函数当前没有尾图输入，需纳入草稿状态或抽出明确自动模式决策。
- `components/VideoGenerationPanel.tsx` 的逐行布局、生成与批量提交；`components/video-tail-frame-state.ts` 的校验和序列化。
- `lib/video-job-create.ts`、`lib/video-tail-frame.ts`、`lib/video-model-capabilities.ts`；检查单条/批量路由共用入口。
- `lib/video-queue.ts`、`lib/video-providers/openai-video.ts`、`lib/company-gateway-tail-frame.ts`；已有底层首尾帧协议应复用。

## 实施要求

1. 两模型均常显首图＋添加尾帧卡，尾帧点击/拖拽及上传状态正常。
2. 单图提交 Reference；有效尾帧提交 FirstFrame/LastFrame；明确移除成功后恢复 Reference。尾图上传中/删除中/失败时阻止提交，不自动偷偷降级。
3. 单条、批量和服务端创建规则一致；界定自动意图请求与显式 API/画布模式。已存在任务重试按冻结字段执行，禁止在 worker 重新按“当前 UI 规则”推导历史模式。
4. 与 04 预处理衔接；保留模型精确匹配、时长、输出档位、Wan 比例及 COS 门禁。更新旧 reference 中固定全能参考的描述。

## 验收

- [x] 两模型各自验证单图→上传尾图→移除尾图三种提交，捕获实际 FileInfos Usage 与任务冻结字段。
- [x] 上传中、失败、失效/跨项目尾图均不能付费提交；错误草稿不会被序列化为合法单图。
- [x] 批量混合两个模型、单图/双图，各行独立分流；切换供应商无隐式丢图。
- [x] 服务器拒绝伪造/矛盾的自动模式请求；显式多参考 API 与画布合同兼容。
- [x] 老 reference 任务重试仍 Reference，老 image 任务仍首尾帧，不改读最新分镜图。
- [x] 其他可灵/Seedance 模型、合法时长及 multiShot=false 行为不回归。
- [x] 结合 04，大首图单图及大首尾图两种模式均通过创建与交付。

## 测试与完成证据

扩展 `scripts/video-bulk-provider-state.test.mjs`、`scripts/video-tail-frame-ui-state.test.ts`、`scripts/video-tail-frame-api.test.mjs`、`scripts/video-reference-job-create.test.ts`、`scripts/video-queue-reference.test.ts`、`scripts/openai-video-adapter.test.ts`。现有批量测试故意断言 H3/Wan 丢弃旧尾图，应按新合同重写，不是删断言让它变绿。

浏览器验证真实上传状态和双卡片布局；请求层测试证明角色字段正确。付费真实任务的末帧效果与 mock 请求合同分开记录，不把本地请求通过称为上游画面验收。

## Comments

- 2026-11-05 实施完成（状态 `ready-for-agent` → 待 06 综合验收）。分支 `ticket/05-auto-mode`，已 merge `integration/team-template-video-20261105`。

  **改动**
  - 新增 `lib/video-auto-mode.ts`：浏览器安全的纯决策规则（精确 `openai-video` + `minimax-h3`/`wan-3.0`，三态 `none`/`ready`/`pending`）。前端提交与服务端创建共用同一份，`resolveVideoGenerationSelection` 改为调用它并额外返回 `automaticMode` / `modeBlocked`。
  - `lib/video-job-create.ts`：新增向后兼容字段 `modeIntent`（缺省 `'explicit'`）与 `autoTailState`；`reconcileAutoModeItems` 用库里真实尾帧素材重算模式，矛盾/未完成/带参考素材/非目标模型一律 400 零落任务。缺省 explicit 的显式 API 与画布合同完全不经过此段。
  - `components/video-tail-frame-state.ts`、`components/video-bulk-prompt.ts`、`components/VideoGenerationPanel.tsx`：两模型常显「首帧卡＋添加尾帧卡」双卡片（单图时也走这个布局）、简短模式提示、逐行与批量按行独立分流、阻止原因写进批量状态。
  - 文档：更新 `docs/reference/供应商与队列.md`「固定全能参考」旧描述 + 新增服务端核对段落；`docs/reference/公司网关与COS中转.md` 补模式与预算角色对应关系。

  **实际运行命令与结果**（全绿）
  - 27 个视频相关测试逐个 `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/<name>`：新增 `video-auto-mode.test.ts`；重写 `video-bulk-provider-state.test.mjs` 的 H3/Wan 段（旧断言 "Automatic reference ignores stale tail drafts" 已按新合同替换）；扩展 `video-tail-frame-ui-state.test.ts`、`video-tail-frame-api.test.mjs`、`video-reference-job-create.test.ts`、`video-queue-reference.test.ts`、`openai-video-adapter.test.ts`、`video-model-capabilities.test.ts`、`video-tail-frame-ui-contract.test.mjs`。
  - 浏览器验收 `scripts/video-auto-mode.playwright.test.mjs`（端口 3210，真 `next dev` + 真登录 + Chromium）：PASS，证据在 `outputs/video-auto-mode-evidence/`。
  - `npm run check:main-path` 7 步全通过；`npx eslint` 改动文件无新增 error；`tsc --noEmit` 干净。
  - 既存失败：`scripts/video-duration-api.test.ts` 在干净 HEAD 上也失败（测试未为 `@/lib/team-service/route-wrapper` 提供桩），非本票引入。

  **未完成 / 边界**
  - 上游真实付费任务的末帧画面**未**验收：本票只到「mock 请求合同 + 真实上传 UI/请求字段」层。FileInfos Usage 由 `openai-video-adapter.test.ts` 锁定，冻结字段由 `video-reference-job-create.test.ts` 锁定。
  - 未跑 `npm run build`（按简报由 Lead 统一跑）。

- **06 横向验收复核（2026-11-05，`ticket/06-acceptance` @ `33e8b48`）：通过。**

  06 独立复跑 `video-auto-mode.test.ts`、`video-bulk-provider-state.test.mjs`、
  `video-tail-frame-ui-state.test.ts`、`video-tail-frame-api.test.mjs`、`video-model-capabilities.test.ts`、
  `video-reference-job-create.test.ts`、`video-queue-reference.test.ts`、`openai-video-adapter.test.ts`，
  以及浏览器 `video-auto-mode.playwright.test.mjs`（端口 3210）—— 全部 PASS。

  **跨功能复验**（`scripts/ticket-06-cross-acceptance.mjs`，与其余四项同一构建/同一数据根）：
  - H3 与 Wan 在**同一页面**切模型后都渲染出 `[data-testid="video-frame-pair"]` 双卡片、
    尾帧卡处于空态（`.video-frame-empty`）、提示「未添加尾帧：按单图参考生成」，
    且**无人工模式切换控件**。
  - 服务端决策 `decideVideoGenerationMode()`：两模型 × 单图/有效尾帧/上传中 三态正确，
    **故意传入相反的 `explicitMode` 也会被忽略**（证明「服务端不能只信前端 generationMode」）。
  - 精确 allowlist 复验：`minimax-h3-pro` / `wan-3` / `minimax-h3 `（尾空格）/ `MINIMAX-H3` /
    `jimeng+minimax-h3` 均**不**进入自动模式；可灵 3.0 沿用显式模式。

  **未做**：真实上游付费任务的末帧画面（本轮全 mock，未向生产补跑）；生产部署
  （生产 release `sourceCommit=ce4a62e`，不含本票修复）。

