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

- [ ] 两模型各自验证单图→上传尾图→移除尾图三种提交，捕获实际 FileInfos Usage 与任务冻结字段。
- [ ] 上传中、失败、失效/跨项目尾图均不能付费提交；错误草稿不会被序列化为合法单图。
- [ ] 批量混合两个模型、单图/双图，各行独立分流；切换供应商无隐式丢图。
- [ ] 服务器拒绝伪造/矛盾的自动模式请求；显式多参考 API 与画布合同兼容。
- [ ] 老 reference 任务重试仍 Reference，老 image 任务仍首尾帧，不改读最新分镜图。
- [ ] 其他可灵/Seedance 模型、合法时长及 multiShot=false 行为不回归。
- [ ] 结合 04，大首图单图及大首尾图两种模式均通过创建与交付。

## 测试与完成证据

扩展 `scripts/video-bulk-provider-state.test.mjs`、`scripts/video-tail-frame-ui-state.test.ts`、`scripts/video-tail-frame-api.test.mjs`、`scripts/video-reference-job-create.test.ts`、`scripts/video-queue-reference.test.ts`、`scripts/openai-video-adapter.test.ts`。现有批量测试故意断言 H3/Wan 丢弃旧尾图，应按新合同重写，不是删断言让它变绿。

浏览器验证真实上传状态和双卡片布局；请求层测试证明角色字段正确。付费真实任务的末帧效果与 mock 请求合同分开记录，不把本地请求通过称为上游画面验收。

## Comments

- 尚未实施。
