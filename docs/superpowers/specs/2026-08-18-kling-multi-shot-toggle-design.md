# 可灵 3.0 智能分镜开关设计

日期：2026-08-18

## 目标

- 给视频生成增加「智能分镜」开关，让用户可以关闭可灵 v3/3.0 模型的多镜头自动分镜。
- 默认保持开启，不改变任何线上既有行为。
- 不支持的模型（可灵 Omni、可灵 v2.x、即梦 Seedance 等）在界面上禁用开关，不出现「假生效」。

## 当前事实

- 智能分镜目前不是可选项，而是硬编码常开：
  - 直连可灵 `lib/video-providers/kling.ts`：模型名匹配 `/v3|3\.0/i` 时无条件发送 `multi_shot: 'true'` + `shot_type: 'intelligence'`（原生接口要求字符串）。
  - 公司网关 `lib/video-providers/openai-video.ts`：模型名匹配 `/v3|3\.0/i` 且不匹配 `/omni/i` 时发送 `multi_shot: true` + `shot_type: 'intelligence'`（网关协议为 JSON boolean；Omni 不支持，不能传）。
- 尾帧（`tailImageId`）已有一条完整的「per-model 能力声明 + 开关贯通」链路，是本设计的直接模板：
  - 适配器可选方法 `tailFrameCapability(model)`（`lib/video-providers/types.ts`），公司网关的精确别名 allowlist 在 `lib/company-gateway-tail-frame.ts`，统一入口 `lib/video-tail-frame.ts` 的 `getVideoTailFrameCapability`。
  - 能力经 `app/api/providers/video/route.ts` 与 `app/api/providers/video/[id]/route.ts` 下发前端。
  - 前端行状态在 `components/video-tail-frame-state.ts`，面板按行查能力并启用/禁用控件。
  - DB 迁移为 `lib/db-migrations.ts` 追加一行 `ALTER TABLE`，队列入库字段经 `VideoJobRecord` + `SELECT *` 自动流入，`SubmitVideoRequest` 透传给适配器。
- 视频任务创建走 `components/VideoGenerationPanel.tsx` → `POST /api/shot-sets/[id]/video-jobs/batch`（另有单条遗留路由 `app/api/shot-sets/[id]/video-jobs/route.ts` 需同步）。
- 探测脚本（`scripts/probe-kling-*.ts`、`scripts/company-kling-tailframe-e2e.ts`）写死了 `multi_shot`/`shot_type` 字段；它们是手动脚本，验证的是默认开启行为，不需要改动。

## 设计

### 能力声明（per-model，完整版）

新增 `lib/video-multi-shot.ts`，与 `lib/video-tail-frame.ts` 同构：

- 适配器在 `lib/video-providers/types.ts` 增加可选方法 `multiShotCapability(model): { supported: boolean; reason?: string }`。
- 直连 kling：`/v3|3\.0/i.test(model) && !/omni/i.test(model)` 时支持，reason 区分「Omni 不支持智能分镜」与「该模型不支持智能分镜」。
- openai-video（公司网关）：精确别名 allowlist，当前仅 `kling-3.0`（及后续核验过的可灵 3.x 别名）支持；Seedance 别名不支持。allowlist 与尾帧的 `lib/company-gateway-tail-frame.ts` 并列，可放同文件或新建 `company-gateway-multi-shot.ts`，实现时按代码就近原则选一处。
- jimeng：不声明该方法，统一入口按不支持处理。
- 统一入口 `getVideoMultiShotCapability(provider, model)`，未声明方法的适配器一律返回不支持。
- `app/api/providers/video/route.ts` 与 `[id]/route.ts` 在 provider JSON 中增加 `multiShotCapability` 字段（按当前默认模型计算，与 `tailFrameCapability` 同款）。

### 数据与链路

- `lib/db-migrations.ts` 追加：`ALTER TABLE video_jobs ADD COLUMN multiShot INTEGER NOT NULL DEFAULT 1`。默认 1 保持线上行为不变。
- 创建 API：batch 路由与单条路由的 item 增加可选 `multiShot` boolean，缺省 true，入库前做布尔归一化；不做能力硬校验（能力由前端禁用保证，API 层容忍传入，适配器最终仍按模型正则兜底，Omni 永不发送）。
- `lib/video-queue.ts`：`VideoJobRecord` 增加 `multiShot: number`；提交组装时透传 `SubmitVideoRequest.multiShot`（`multiShot !== 0`）。retry 路由只重置状态，任务重跑从 DB 行重新读参，开关自动继承。
- `lib/video-providers/types.ts`：`SubmitVideoRequest` 增加可选 `multiShot?: boolean`。
- 适配器发送条件由硬编码改为开关感知：
  - kling.ts：`request.multiShot !== false && /v3|3\.0/i.test(model)` 时发送（字符串值）。
  - openai-video.ts：`request.multiShot !== false && /v3|3\.0/i.test(model) && !/omni/i.test(model)` 时发送（boolean 值）。
  - 缺省（旧行、未传）一律视为开启，与 `DEFAULT 1` 一致。

### 界面

- `components/video-tail-frame-state.ts` 的 `VideoMotionRow` 增加 `multiShot: boolean`（默认 true），`getVideoMotionRowIssue` 增加「当前模型不支持智能分镜」提示（行值异常时兜底）。
- `components/VideoGenerationPanel.tsx`：运镜行控件区（时长输入旁）增加「智能分镜」勾选框；按行查询 `multiShotCapability`，不支持的模型禁用勾选框并强制视为关闭，hover 提示原因；切换供应商/模型时按新能力重算行状态。
- 已有任务行展示沿用现有字段渲染，不额外加历史标记。

## 数据流

1. 用户在运镜行勾选/取消「智能分镜」（默认勾选；不支持的模型禁用）。
2. 创建视频任务时 `multiShot` 随 item 入库 `video_jobs.multiShot`。
3. 队列领取任务，读出该列并透传 `SubmitVideoRequest.multiShot`。
4. 适配器按「开关开 + 模型支持」双条件决定是否发送 `multi_shot`/`shot_type`。
5. 失败重试从 DB 行重新读参，开关状态不丢。

## 错误与兼容性

- 默认开启：旧任务、未传该字段的新任务、探测脚本的行为与今天完全一致。
- Omni 模型在任何情况下都不会收到这两个字段（开关与模型正则双重兜底）。
- 开关只影响提交阶段；进行中的任务不受后续编辑影响（任务参数以提交时 DB 行为准）。
- 不引入新供应商、不改动尾帧链路、不改动轮询与下载逻辑。

## 测试与验收

- 适配器测试（`scripts/openai-video-adapter.test.ts` 及 kling 对应测试）：默认仍发送两字段；显式关闭不发送；Omni 无论开关都不发送；非 v3 模型不发送。
- 迁移测试（`scripts/db-migrations.test.ts`）：新列存在且默认 1，既有行升级后为 1。
- 创建 API 测试：batch/单条路由接受并入库 `multiShot`，缺省为 true。
- UI 合同/状态测试（参照 `scripts/video-tail-frame-ui-contract.test.mjs` 写法）：行默认值、能力禁用时强制关闭、能力随供应商切换重算。
- 运行相关独立测试与 ESLint。

## 非目标

- 不做自定义分镜（`multi_prompt` 逐镜头定义）。
- 不为智能分镜增加专门的提示词模板机制。
- 不改动 Seedance、Omni 等其他模型的任何请求参数。
