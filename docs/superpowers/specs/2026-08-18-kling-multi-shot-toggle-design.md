# 公司可灵 3.0 智能分镜开关设计

日期：2026-08-18

## 目标

- v1 只为公司视频 API（`openai-video`）的精确模型 `kling-3.0` 提供「智能分镜」开关。
- 公司 `kling-3.0` 行默认开启；用户关闭后，提交给公司网关的请求不带 `multi_shot` 与 `shot_type`。
- 直连可灵渠道、其他供应商、其他模型均不显示该开关，也不由本功能改写其既有发参行为。
- 后端以供应商与模型的精确组合为唯一能力边界，不能把前端是否展示控件当作校验。

## 当前事实

- 直连可灵适配器 `lib/video-providers/kling.ts` 当前按自身已有规则发送原生协议字段：受支持模型使用字符串值 `multi_shot: 'true'` 与 `shot_type: 'intelligence'`。该适配器属于本 v1 范围外，继续沿用现有请求契约。
- 公司网关适配器 `lib/video-providers/openai-video.ts` 当前为可灵智能分镜发送 JSON boolean `multi_shot: true` 与 `shot_type: 'intelligence'`。v1 将开关接入公司精确 `kling-3.0` 任务；非目标模型不由该开关管理。
- 视频任务创建有批量路由 `POST /api/shot-sets/[id]/video-jobs/batch` 和单条路由 `app/api/shot-sets/[id]/video-jobs/route.ts`，两条入口都必须使用同一套服务端精确能力判断。
- 队列从 `video_jobs` 读取任务记录，再把创建时保存的参数传给适配器；重试只重置任务状态，适配器参数应继续来自同一条数据库记录。
- 当前 `video_jobs` 没有可选智能分镜字段；迁移后的新列必须允许 `NULL`，以区分未受本功能管理的渠道/模型。

## 设计

### 精确能力边界

定义唯一受管组合：

```ts
providerType === 'openai-video' && model === 'kling-3.0'
```

- 该判断是服务端共享的小范围谓词或能力函数，批量创建、单条创建、供应商能力响应和适配器发参均以它为准。
- 不使用 `/v3/`、`/3.0/`、大小写不敏感匹配、别名或“所有可灵 3.x”规则；`kling-v3`、`kling-v3.0`、`kling-3.0-fast`、Omni、Seedance 及其他名称都不是 v1 目标。
- 能力响应只需让前端识别精确公司 `kling-3.0` 行可用；非目标行不提供可渲染的智能分镜控件状态。不得把它扩展成所有供应商的通用模型开关框架。

### 数据库与创建链路

- `lib/db-migrations.ts` 追加 nullable 列：

  ```sql
  ALTER TABLE video_jobs ADD COLUMN multiShot INTEGER
  ```

- `multiShot` 的持久化语义固定为：`NULL` 表示该任务所属渠道/模型不受智能分镜功能管理；`1` 表示公司 `openai-video`/`kling-3.0` 选择开启；`0` 表示该精确组合选择关闭。不要设置 `NOT NULL` 或默认值。
- 批量和单条创建 API 都接受可选的 `multiShot` 输入，但在服务端先按精确能力边界归一化：
  - 对 `openai-video` + `kling-3.0`，缺省值按 `true` 处理，布尔值写入 `1` 或 `0`。
  - 对所有其他供应商/模型，忽略该输入并写入 `NULL`，不得让客户端伪造受管状态。
- 创建 API 不依赖前端隐藏控件来防护；请求即使带有 `multiShot`，也必须由服务端重新判断供应商与精确模型后决定写 `1/0` 还是 `NULL`。
- `VideoJobRecord.multiShot` 使用 `number | null`。队列组装 `SubmitVideoRequest` 时，`1` 传 `true`、`0` 传 `false`，`NULL` 省略该可选字段；旧任务因此保留历史默认行为。
- 重试从数据库重新读取原任务行，继承该行的 `multiShot` 值；重试 API 不接受新的智能分镜覆盖值，也不把 `NULL` 改写成 `1`。

### 公司网关适配器

- `lib/video-providers/openai-video.ts` 仅在以下条件同时满足时注入字段：

  ```ts
  request.model === 'kling-3.0' && request.multiShot !== false
  ```

- 注入内容为 JSON boolean `multi_shot: true` 与字符串 `shot_type: 'intelligence'`。`request.multiShot === false` 时两个字段都不发送。
- 该条件只描述公司网关适配器的受管可灵 3.0 合同；不把开关值用于其他模型，也不借此改变其他渠道的请求结构。
- `lib/video-providers/kling.ts` 归入范围外，继续使用现有 `multi_shot` 字符串字段和判断；本设计不向直连渠道暴露此能力。

### 界面

- `components/VideoGenerationPanel.tsx` 只在供应商为 `openai-video` 且模型精确为 `kling-3.0` 的运镜行渲染「智能分镜」勾选框，初始值为开启。
- 其他渠道和模型直接不渲染该控件；不显示灰色假状态或“当前模型不支持”的替代控件。切换到非目标组合时，界面移除该控件，不能把它的值作为受管状态提交。
- 供应商能力接口如需下发状态，只下发服务端精确判断得到的目标行能力；前端展示是便利层，不能替代创建 API 的归一化。
- 已有任务只按任务状态展示，不在非目标历史任务上补画开关；重新提交/重试时以数据库中的 `multiShot` 为准。

## 数据流

1. 前端根据供应商与模型精确组合识别公司 `openai-video`/`kling-3.0` 行，只在该行显示默认开启的开关。
2. 创建请求分别进入批量或单条 API；服务端重新判断精确组合。目标组合写入 `multiShot` 为 `1/0`，其余组合统一写 `NULL`。
3. 队列领取任务，从 `video_jobs` 读取 `multiShot`；`1/0` 转成布尔值，`NULL` 不向适配器传开关字段。
4. `openai-video` 仅对精确 `kling-3.0` 且 `multiShot !== false` 的请求发送 JSON boolean `multi_shot` 与 `shot_type`；关闭时两者均省略。
5. 直连可灵及其他适配器沿用各自既有发参路径，不读取或管理该开关。
6. 失败重试重新读取原数据库行，继承原来的 `1/0/NULL`，不因重试丢失选择。

## 错误与兼容性

- 迁移不设默认值：历史任务的 `multiShot` 为 `NULL`，表示它们没有被本功能管理。创建 API 的旧客户端不传字段时，只有精确公司 `kling-3.0` 新任务按开启写入 `1`；其他新任务写 `NULL`。
- 适配器对精确公司 `kling-3.0` 的旧数据库行收到 `NULL` 时，`request.multiShot !== false` 仍按开启发送，保持历史“默认开启”的提交行为；新建的目标任务会明确保存 `1`。非目标任务的 `NULL` 不触发本功能。
- 用户修改开关只影响尚未提交的新任务；已提交任务的参数冻结在 `video_jobs` 行，进行中的任务不受面板后续编辑影响。
- 直连可灵、其他供应商和其他模型沿用本设计范围之外的既有请求格式；本设计不把它们迁移到公司网关能力模型。

## 测试与验收

- 迁移测试（`scripts/db-migrations.test.ts`）：`video_jobs.multiShot` 存在、允许 `NULL`、没有默认 `1`；历史行升级后仍为 `NULL`。
- 创建 API 测试覆盖批量和单条入口：精确 `openai-video` + `kling-3.0` 缺省写 `1`、显式 `false` 写 `0`；其他供应商/模型即使传入 `true/false` 也写 `NULL`。
- `openai-video` 适配器测试：精确 `kling-3.0` 在值缺省/为 `true` 时发送 JSON boolean `multi_shot` 和 `shot_type`，为 `false` 时两个字段均不发送；非精确模型不因该开关注入这些字段。
- 队列/重试测试：数据库中的 `1/0/NULL` 分别按约定透传、关闭或省略；重试重新读取同一行并继承原值。
- UI 合同测试：只有公司 `openai-video` 的精确 `kling-3.0` 行出现开关且默认开启；直连可灵、其他渠道和模型不出现该控件，也不生成占位状态。
- 直连 `kling.ts` 既有测试与手动探测脚本按现状保留；不新增智能分镜开关相关测试。
- 运行与本次实现相关的独立测试及 ESLint；验收时额外全文复核精确模型边界、可空语义、布尔类型、重试继承和非目标行不渲染控件。

## 非目标

- `lib/video-providers/kling.ts` 属于范围外；直连可灵行不渲染该控件。
- 不支持 `kling-v3`、`kling-v3.0`、`kling-3.0-fast`、Omni、Seedance 或其他供应商/模型的智能分镜开关，也不建立通用模型开关体系。
- 不为非目标渠道/模型写入 `multiShot` 的 `1/0`，不借本功能改变其既有发参行为。
- 不使用列默认值；不把 `NULL` 伪装成用户已选择开启。
- 不做自定义分镜（`multi_prompt` 逐镜头定义）、专门的智能分镜提示词模板、智能分镜之外的尾帧或轮询改造。
