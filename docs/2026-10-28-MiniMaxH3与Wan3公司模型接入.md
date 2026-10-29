# MiniMax H3 与 Wan 3.0 公司模型接入

## 能力与来源

核对日期：2026-10-28。公司模型名为 `minimax-h3`、`wan-3.0`，均使用现有公司可灵的网关及 Key。

| 模型 | 固定时长 | 官方原生清晰度 | 本次工作台默认 | 首尾帧 | 可灵智能分镜开关 |
| --- | --- | --- | --- | --- | --- |
| MiniMax H3 | 4–15 秒整数 | 768P / 2K | 2K | 支持 | 不发送 |
| Wan 3.0 | 2–30 秒整数 | 480P / 720P / 1080P | 1080P | 支持 | 不发送 |

官方来源：

- [MiniMax 创建视频任务](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)：`MiniMax-H3` 使用 `content` 角色 `first_frame` / `last_frame`，`duration` 为 4–15，`resolution` 为 768P / 2K。
- [阿里云万相 3.0 API](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)：无视频输入时固定时长为 2–30，支持 `first_frame` / `last_frame`；原生分辨率为 480P / 720P / 1080P。官方自动时长 `-1`、多模态参考和视频编辑不在本次工作台首帧入口范围内。
- [腾讯 CreateAigcVideoTask](https://cloud.tencent.com/document/api/266/126239) 与 [数据结构](https://cloud.tencent.com/document/api/266/31773)：首尾帧可由 `FileInfos[].Usage=FirstFrame/LastFrame` 表达，输出规格经 `OutputConfig` 传递。
- 用户提供的 [Modelink OpenAI 风格视频文档](https://docs.modelink.ai/api/video-openai-style#createVideoKlingO1) 当前主要描述 Kling Omni / Sora，不能用于认定 H3 / Wan 支持可灵的 `multi_shot` / `shot_type`。

## 公司网关证据与实际请求

公司网关 `GET /v1/models` 返回 200，并列出这两个精确别名。使用现有可灵 Key；不保存或打印 Key。

参数探测均为故意非法请求，未上传真实素材，所有请求返回 HTTP 400，没有创建生成任务：

1. 空提示词：`prompt is required`。
2. `OutputConfig` 为字符串：两个模型都返回 `tencent_video: OutputConfig must be an object`。
3. `LastFrameUrl` 为数字：两个模型都报告腾讯 `CreateAigcVideoTaskRequest.LastFrameUrl` 字符串类型反序列化失败。
4. `FileInfos[].Url` 为数字：两个模型都报告腾讯 `AigcVideoTaskInputFileInfo.FileInfos.Url` 字符串类型反序列化失败。

因此，这两个公司别名进入腾讯视频原生参数透传通道，而非直接使用原厂的 HTTP 接口。最终请求继续发往本机 LiteLLM 的 `/v1/videos`，包括：

```json
{
  "model": "minimax-h3",
  "prompt": "镜头缓慢推进产品细节",
  "seconds": "5",
  "FileInfos": [
    { "Type": "Url", "Category": "Image", "Url": "<COS first-frame URL>", "Usage": "FirstFrame" },
    { "Type": "Url", "Category": "Image", "Url": "<COS last-frame URL>", "Usage": "LastFrame" }
  ],
  "OutputConfig": { "Duration": 5, "Resolution": "2K" }
}
```

单首帧只保留第一个 FileInfos 元素；Wan 使用 `Resolution=1080P`，并显式传 `OutputConfig.AspectRatio`，按首帧尺寸吸附到 `16:9 / 1:1 / 3:4 / 4:3 / 9:16`。无法读取尺寸时在上传及 POST 前失败。H3 不传比例。显式帧角色避免普通参考图语义；两者都不传 `images`、`size`、`LastFrameUrl` 或可灵专用开关。

真实测试发现：Wan 不传比例会在创建前返回 HTTP 400，报告 `AspectRatio adaptive is not supported for model Wan 3.0`。因此公司通道不能直接照搬原厂的 adaptive 行为；修正为上述五种显式比例后成功。

## 实现与运行

- `lib/company-gateway-video-models.ts`：两个精确别名的时长边界与默认清晰度；不接受大小写变体、H3 Max 或 Wan Prime。
- `lib/video-duration.ts`：只对 `openai-video` 的两个精确别名应用新时长合同，设置页、单条/批量入口与适配器共用。
- `lib/company-gateway-tail-frame.ts`：精确声明 `company-gateway-tencent-file-infos` 尾帧协议。
- `lib/video-providers/openai-video.ts`：新模型的单首帧与首尾帧均要求本机回环 LiteLLM + COS，禁止本机 URL 回退；双帧复用现有上传及失败关闭规则。
- `lib/seed.ts`：补种 `company-minimax-h3`、`company-wan-3-0`，默认 5 秒；已有同 ID 的用户配置不覆盖。
- `litellm-config.example.yaml`：新增无密钥示例；本机忽略文件 `config.yaml` 从现有可灵配置复用网关及 Key，保留所有旧条目。

本次不新增供应商类型、不改队列与数据库结构、不套用可灵价格。公司账单定价尚无来源，不补造估算价格。新模型已加入创作画布的独立能力目录，详见下文。

## 验证与边界

已通过适配器、时长、单条/批量 API、尾帧验证、智能分镜、公司供应商补种测试及变更文件 ESLint。API 测试的旧返工 fixture 缺少当前 guard 查询所需的 `variantId` 与 `final_edit_variants`，已补齐最小表结构。

`scripts/litellm-video-forwarding.test.mjs` 实际启动隔离的本机 LiteLLM，以假 Key、假 COS 和回环假上游验证两个新模型单帧/双帧的 `FileInfos`、`OutputConfig`、`seconds` 和原始模型名均透传；现有七牛可灵开关仍通过回归。

用户随后明确授权付费测试，已通过工作台适配器 → 本机 LiteLLM → 公司网关完成各一个真实首尾帧任务。测试结果见下；最大时长、其他画幅、单首帧真实出片与智能分镜未做付费验收。

本机运行配置已生效：当前数据库两项预设均启用、默认 5 秒；通过项目启停脚本启动的 LiteLLM 仅监听 `127.0.0.1:4000`，健康检查与模型列表均返回 200。经真实本机代理向两个新别名分别发送非法 `OutputConfig` 的验证请求，都到达公司网关并返回相同腾讯参数 400，没有创建任务。全量 TypeScript 检查通过。

`npm run build` 已成功完成并同步 standalone 资源，桌面构建戳检查通过。构建输出仍有 `next.config.ts` 文件追踪警告，未阻塞编译、类型检查、页面生成或资源同步。

## 付费出片实测（2026-10-28）

输入为 1024×768 的两张 4:3 测试图：椅子从左侧平移至右侧，红球 A、蓝方块 B、文字和背景固定。两帧均走 COS。提示词要求单镜头移动与首尾构图一致。

| 模型 | 请求 | 实际视频 | 完成并下载耗时 |
| --- | --- | --- | --- |
| minimax-h3 | 4 秒、2K、首尾帧 | 1920×1440，24fps，107 帧，视频轨道 4.458984 秒，容器 4.459 秒 | 约 4 分 49 秒 |
| wan-3.0 | 2 秒、1080P、首尾帧、4:3 | 1662×1246，30fps，60 帧，视频轨道 2 秒，音频约 2.066 秒、容器约 2.067 秒 | 约 1 分 46 秒 |

两条均为 H.264 / yuv420p + AAC。以上耗时包含上传、轮询间隔和下载，不等于服务端纯生成时间。H3 返回的时长比请求多约 0.459 秒，保留原片，不在适配器暗中裁剪；分辨率档位以真实像素为准，不假定 2K 必为 2560×1440、1080P 必为 1920×1080。

目视比较输入图、生成首帧、中间帧与真实末帧：两模型首帧保持左侧椅子、末帧收束到右侧椅子；A/B 标记、文字与背景构图保持，中间帧显示椅子位移。此为构图验收，不宣称逐像素一致或全面的运动质量评测。抽取末帧时按解码帧取最后一帧，不能按容器时长减一帧定位（音频可能比画面长）。

本机产物位于 `outputs/company-native-video-smoke-2026-10-28/`：`minimax-h3.mp4`、`wan-3.0.mp4`、`comparison.png`、输入与抽帧图片、`prompt.txt`、任务回执 `state.json`。回执记录已有任务 ID；轮询不重复提交。测试脚本 `scripts/company-native-video-smoke.ts` 支持 `prepare`、`submit --confirm-paid`、`poll`、`inspect`、`status`；仅明确无任务 ID 的创建前 HTTP 400 可用 `--retry-rejected` 重试。首次 Wan 比例错误即属于此类，随后成功创建一条任务。实际扣费金额需以公司账单为准。

## 创作画布扩展

画布按已启用、有地址和 Key 的 `openai-video` 行精确注册两模型，使用用户设置的供应商名称。停用后从可选列表移除，历史能力保留供恢复。以下选项只扩展画布，主工作台继续用原先默认档位。

| 参数 | MiniMax H3 | Wan 3.0 |
| --- | --- | --- |
| 模式 | 文生视频、图生视频（首尾帧）、参考生视频 | 同左 |
| 分辨率 | 768P / 2K，默认 2K | 480P / 720P / 1080P，默认 1080P |
| 整数时长 | 4–15 秒，默认 5 秒 | 2–30 秒，默认 5 秒 |
| 文生/参考生比例 | 21:9、16:9、4:3、1:1、3:4、9:16 | 16:9、1:1、3:4、4:3、9:16 |
| 参考图片 | 最多 9 张 | 最多 10 张 |
| 参考视频/音频 | 每类最多 3 段，每段 2–15 秒，各类合计 ≤15 秒 | 每类最多 5 段，每段 1–15 秒，各类合计 ≤15 秒；输入视频 + 输出时长 ≤30 秒 |

文生不发送占位媒体；图生按参考列表顺序赋予 `FirstFrame` / `LastFrame`；参考生用 `Usage=Reference`，按素材类型填写 `Category=Image/Video/Audio`，不承诺首尾构图锁定。参考生至少一份媒体，允许纯音频参考；首尾帧不可与参考媒体混用。所有素材要求 COS，提交地址只允许本机回环 LiteLLM。准备及 POST 前重验模式、参数与参考时长。

素材限制取原厂和公司通道交集：参考图片开放 JPEG/PNG、单张 ≤10 MiB；视频 MP4/MOV，H3 单段 ≤50 MiB、Wan ≤100 MiB；音频 WAV/MP3、单段 ≤15 MiB。不开放 Wan 的文件/网页输入、自动时长 -1、视频编辑/延长及未核验的音频开关。Wan 原厂支持 adaptive/21:9，但公司已返回的白名单只有五种显式比例，画布沿用公司限制。H3 只开放原厂原生 768P/2K，不将腾讯增强输出的 1080P/4K 宣称为原生能力。

依据仍为本文上列原厂创建任务及腾讯数据结构文档（2026-10-28 再核对）。画布能力保持 `mapped`：下列四条付费样例加既有两条首尾帧样例，不代表所有参考媒体组合和参数档位均已验收。本地测试覆盖供应商发现/停用、三模式各档位请求、规划→单次 POST→轮询→下载→发布、COS 缺失/非回环地址零提交、非法素材组合与时长拒绝。

用户明确授权「新增4条付费验收」后，通过 `outputs/canvas-native-video-smoke-2026-10-28/run.mjs` 提交 H3 文生/参考生各 4 秒 768P，Wan 文生 2 秒 480P、参考生 2 秒 720P，共四条；2026-10-28 11:22（UTC+8）均成功取得任务 ID。脚本经过实际画布规划和执行适配器，使用独立画布数据根，供应商密钥只在临时内存表，提交前落回执；有远端 ID 仅轮询，不自动重发。本轮参考生使用一张图片，视频/音频参考及多素材组合不属于这四条真实样本。

### 画布四条付费验收结果

四条均成功完成并下载，未重提任务。所有请求选择 16:9；文生只传提示词，参考生传同一张 1024×768 椅子图，要求保留木椅及米色靠垫、换成带绿植的阳光客厅。

| 模型/模式 | 请求 | 实际像素 | 视频时长/帧率 | 提交至下载 |
| --- | --- | --- | --- | --- |
| H3 文生 | 768P / 4 秒 | 1344×768 | 4.458984 秒 / 24fps（107 帧） | 2 分 34 秒 |
| H3 图片参考生 | 768P / 4 秒 | 1344×768 | 4.458984 秒 / 24fps（107 帧） | 3 分 50 秒 |
| Wan 文生 | 480P / 2 秒 | 854×480 | 2 秒 / 30fps（60 帧） | 6 分 58 秒 |
| Wan 图片参考生 | 720P / 2 秒 | 1280×720 | 2 秒 / 30fps（60 帧） | 6 分 58 秒 |

均为 H.264 / yuv420p + AAC。H3 容器 4.459 秒、音频 4.45 秒；Wan 容器及音频 2.02 秒。H3 的 16:9 档实际落 1344×768，保留原生尺寸；不补拉伸。计时包含轮询间隔和下载。实际费用以公司账单为准。

首/中/末抽帧检查：文生均生成米色座椅与稳定背景，镜头逐渐推进；参考生均保留输入椅子的木制框架、米色靠垫等主要视觉特征，并生成阳光、绿植和新客厅环境。参考生是语义参考与重新构图，不是逐像素锁定；本轮未覆盖视频/音频参考、多参考图、极限时长及其他比例的真实出片。

产物目录：`outputs/canvas-native-video-smoke-2026-10-28/`。四条原片按 `<model>-<mode>.mp4` 保存；`comparison.png` 是四行首/中/末帧对照，`media-report.json` 保存 FFprobe 轨道数据，`state.json` 保存任务 ID 与时间，`inspect.mjs` 可重做无付费媒体检查。画布功能与先前桌面构建已完成，本次只新增真实验收产物与记录，不改变请求合同。
