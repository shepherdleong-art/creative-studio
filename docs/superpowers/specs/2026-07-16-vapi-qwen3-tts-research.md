# V-API `qwen3-tts-flash` 接入研究

> 日期：2026-07-16  
> 范围：确认 V-API（`api.v3.cm`）的 `qwen3-tts-flash` 生产接入事实；结论已回填主 PRD 与技术方案  
> 结论状态：TTS 接口已确认；字幕逐字对齐仍需独立 `AlignmentPort`

## 1. 结论

1. 供应商是 V-API。它的官网入口是 `https://api.v3.cm`，但官方 Qwen TTS OpenAPI 把线上服务器写成 `https://api.gpt.ge`，所以用户截图中的 `https://api.gpt.ge/v1/audio/speech` 没有指错供应商。[V-API Qwen TTS OpenAPI](https://api-gpt-ge.apifox.cn/356760467e0.md)
2. `api.v3.cm` 的公开站点状态同时把 `https://api.gpt.ge` 和 `https://api.v3.cm` 列为“全球通用”API 线路，并把当前默认 `server_address` 设为 `https://api.gpt.ge`。因此两个域名属于同一套 V-API 服务；本项目按用户已确认的选择把 `https://api.v3.cm` 作为默认值，同时保留可编辑 Base URL。[V-API 公开站点状态](https://api.v3.cm/api/status)
3. 请求路径和 Bearer 鉴权沿用 OpenAI 风格，但 `qwen3-tts-flash` 的成功响应不是音频二进制，而是包含临时 WAV URL 的 JSON。它不能直接复用“请求后把 body 当 MP3”的通用 OpenAI TTS adapter，必须有 V-API Qwen 专用响应解析。
4. 官方请求契约只定义 `model`、`input`、`voice` 三个字段；没有 `speed`、`response_format`、`timestamp_granularities` 或其他时间戳字段。[V-API Qwen TTS OpenAPI](https://api-gpt-ge.apifox.cn/356760467e0.md)
5. 语速要在下载音频后用 FFmpeg `atempo` 做本地后处理；字幕对齐要对“已经应用最终语速”的音频调用独立 `AlignmentPort`。不能从该 TTS 响应推导逐字时间戳。

## 2. 建议配置

| 设置项 | 建议值 | 说明 |
|---|---|---|
| `providerId` | `vapi-qwen3-tts` | 稳定内部 ID |
| 显示名称 | `V-API Qwen3 TTS` | 避免把线路域名误当供应商名 |
| adapter type | `vapi-qwen-tts` | 不使用只接受二进制音频的 generic OpenAI adapter |
| 默认 Base URL | `https://api.v3.cm` | 用户已确认使用，且是 V-API 官网公开列出的同服务全球线路 |
| 文档示例 Base URL | `https://api.gpt.ge` | V-API 官方 OpenAPI 的 `servers.url` |
| Speech path | `/v1/audio/speech` | `POST` |
| 鉴权 | `Authorization: Bearer <API_KEY>` | `Content-Type: application/json` |
| 模型 | `qwen3-tts-flash` | 设置页可固定显示，V1 不必让用户编辑 |
| 默认音色 | `Cherry` | 官方示例音色 |
| 单次输入上限 | 600 字符 | 应在发请求前校验；超长脚本按自然句分段 |
| 供应商语速参数 | 无 | 不发送未文档化的 `speed` |
| 供应商输出格式参数 | 无 | 不发送未文档化的 `response_format` |
| 成功响应 | JSON + 临时音频 URL | 服务端立即下载并保存到本地工作区 |

V-API 当前公开定价数据仍将 `qwen3-tts-flash` 标为存在，并把它归入 `speech` 端点和 `default` 分组。[V-API 公开定价数据](https://api.v3.cm/api/pricing)

## 3. 请求契约

```http
POST https://api.gpt.ge/v1/audio/speech
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "model": "qwen3-tts-flash",
  "input": "您好，我是语音助手。",
  "voice": "Cherry"
}
```

三个字段都是必填。`input` 最大 600 个字符。应用如果允许 `https://api.v3.cm`，只替换 host，路径和请求体不变。[V-API Qwen TTS OpenAPI](https://api-gpt-ge.apifox.cn/356760467e0.md)

建议沿用“Base URL 可含或不含 `/v1`”的规范化规则，但内部最终必须得到且只得到一个 `/v1/audio/speech`：

```ts
function speechUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v1$/i.test(base)
    ? `${base}/audio/speech`
    : `${base}/v1/audio/speech`;
}
```

## 4. 成功响应与音频落盘

`qwen3-tts-flash` 的文档示例结构为：

```json
{
  "output": {
    "audio": {
      "data": "",
      "expires_at": 1759160443,
      "id": "audio_ba0bc631-ba8b-428b-8868-069a26f0bfa5",
      "url": "http://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/...wav?..."
    },
    "finish_reason": "stop"
  },
  "usage": {
    "characters": 47
  },
  "request_id": "ba0bc631-ba8b-428b-8868-069a26f0bfa5"
}
```

来源：[V-API Qwen TTS OpenAPI](https://api-gpt-ge.apifox.cn/356760467e0.md)。

adapter 应执行以下流程：

1. 严格校验 JSON 中的 `output.audio.url`、`expires_at`、`request_id`。
2. 立即由服务端下载临时 URL；不把远端 URL 当永久资产。
3. 不在日志中记录 Bearer token 或完整带签名的音频 URL。
4. 用 FFprobe 获取真实格式、采样率和时长，再转换为应用内部统一音频格式。
5. 如语速不为 `1.0`，对已下载音频应用 FFmpeg `atempo`，再测量最终真实时长。
6. 保存 `providerId`、Base URL、model、voice、speed、`request_id` 和本地音频路径；不保存密钥。

阿里云上游文档说明非实时合成音频 URL 是临时资源，建议生成后及时下载；这与 V-API 返回 `expires_at` 的结构一致。[阿里云非实时语音合成文档](https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide)

## 5. V-API 明确开放的 17 个音色

应用的 V1 音色下拉应以 V-API 自己的 OpenAPI enum 为准，而不是直接照搬阿里云当前更大的上游音色表。

| `voice` | 中文名 | 描述 |
|---|---|---|
| `Cherry` | 芊悦 | 阳光积极、亲切自然小姐姐 |
| `Ethan` | 晨煦 | 标准普通话，部分北方口音；阳光温暖 |
| `Nofish` | 不吃鱼 | 不会翘舌音的设计师 |
| `Jennifer` | 詹妮弗 | 品牌级、电影质感美语女声 |
| `Ryan` | 甜茶 | 节奏感和戏剧张力强 |
| `Katerina` | 卡捷琳娜 | 御姐音色，韵律感强 |
| `Elias` | 墨讲师 | 严谨、适合知识讲解的叙事女声 |
| `Jada` | 上海-阿珍 | 风风火火的沪上阿姐 |
| `Dylan` | 北京-晓东 | 北京胡同少年 |
| `Sunny` | 四川-晴儿 | 甜美川妹子 |
| `li` | 南京-老李 | 耐心的瑜伽老师 |
| `Marcus` | 陕西-秦川 | 低沉、质朴的陕西男声 |
| `Roy` | 闽南-阿杰 | 诙谐直爽的闽南男声 |
| `Peter` | 天津-李彼得 | 天津相声捧哏风格 |
| `Rocky` | 粤语-阿强 | 幽默风趣的粤语男声 |
| `Kiki` | 粤语-阿清 | 甜美粤语女声 |
| `Eric` | 四川-程川 | 跳脱市井的四川男声 |

来源：[V-API Qwen TTS OpenAPI](https://api-gpt-ge.apifox.cn/356760467e0.md)。

注意：V-API enum 把南京音色写为小写 `li`，阿里云当前上游音色表写为 `Li`。在没有带真实 key 的兼容性测试前，适配器应严格发送 V-API 契约中的 `li`，不要自行改大小写。[阿里云 Qwen-TTS 音色表](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-list)

## 6. 语速、试听与缓存

V-API Qwen TTS OpenAPI 没有 `speed` 字段，所以不能把旧 generic OpenAI TTS 的 `{ speed, response_format: "mp3" }` 请求体原样发送给它。

建议：

- 设置页仍保留语速控件，但把它定义为应用侧后处理参数。
- 试听和正式合成必须走同一条 `TTS -> 下载 -> atempo -> 统一转码` 管线，保证试听结果与成片一致。
- 试听固定句可使用“你好，我是产品素材工作台语音助手。”；preview cache key 至少包含 provider、base URL、model、voice、speed、adapter version。
- 正式 narration cache key 还必须包含规范化后的完整脚本文字。
- FFmpeg `atempo` 完成后再用 FFprobe 记录真实时长；时间轴不能按目标时长或字符数估算。

当前 PRD 只要求“音色、语速、试听”，没有锁定语速最小值、最大值和步长。本研究不替产品补写范围；实施前仍需在技术方案或实施计划中明确。

## 7. 时间戳与字幕对齐

V-API 的 `qwen3-tts-flash` 成功响应只有音频 URL、过期时间、音频 ID、字符用量和请求 ID，没有：

- word timings；
- sentence timings；
- phoneme timings；
- 时间戳开关；
- 可用于强制对齐的 token 时间信息。

因此：

1. `TtsProviderPort.synthesize()` 的 `wordTimings` 对该 adapter 永远为空。
2. 语速后处理完成后，把最终音频和完整 narration 原文交给 `AlignmentPort`。
3. `AlignmentPort` 未返回合格结果前，字幕只可显示为待处理，不能把“字符数平均分配时间”当正式对齐。
4. V-API TTS 配置已能关闭“TTS 供应商未定”这一项，但不能关闭“生产 Alignment adapter 未定”这一项。

## 8. OpenAI 兼容性的准确边界

V-API 的总览文档称服务兼容 OpenAI 协议，且 Qwen TTS 确实使用 OpenAI 风格路径、Bearer header 和 `model/input/voice` 字段。[V-API 模型兼容性说明](https://api-gpt-ge.apifox.cn/5069242m0/)

但本模型的响应是 JSON 音频 URL；OpenAI TTS 常见客户端会预期 `audio/*` 二进制 body。故本项目应把它归类为：

> OpenAI 风格的请求入口 + V-API/Qwen 专用成功响应。

具体实现上可以复用 Base URL 规范化、Bearer header、超时、重试和错误脱敏基础设施，但不能复用“直接把 response body 当音频文件”的成功解析器。

## 9. 错误响应

Qwen TTS OpenAPI 没有声明非 200 response schema。2026-07-16 对两个公开线路做了不带 token 的只读连通性探测：

- `POST https://api.v3.cm/v1/audio/speech`
- `POST https://api.gpt.ge/v1/audio/speech`

两者均返回 HTTP 401，body 形如：

```json
{
  "error": {
    "message": "未提供令牌 (request id: ...)",
    "type": "v_api_error"
  }
}
```

响应头同时包含 `x-oneapi-request-id`。这可以证明两个域名都存在该路由并使用同一类鉴权错误封装，但不能证明其他 4xx/5xx 一定同构。

adapter 的错误处理应：

- 先按 `error.message` / `error.type` 解析；
- 无法解析时保留 HTTP status 和截断后的纯文本；
- 优先记录响应头或响应体里的 request id；
- 绝不回显 API key；
- 把 401/403 标为配置错误，把 429/5xx/网络失败标为可重试错误，但重试次数必须有上限。

## 10. 最小验收清单

接入完成后至少用用户自己的 V-API token 验证：

1. 项目默认 host `api.v3.cm` 能用 `Cherry` 返回 JSON 和可下载 WAV。
2. 文档 host `api.gpt.ge` 能否用同一 token 完成同样请求。
3. 17 个 voice enum 至少逐一做短句试听；重点核对 `li` 大小写。
4. 600 字符成功，601 字符由应用前置阻断。
5. `speed = 1.0` 不走 `atempo`；非 1.0 试听与正式音频听感、时长一致。
6. 远端音频下载失败、URL 过期、返回缺字段、401、429、5xx 都能给出不泄密的可操作错误。
7. 成功音频没有 timings，系统会继续进入 `AlignmentPort`，不会伪造平均时间戳。

## 11. 已确认与未确认边界

已确认：

- V-API 供应商、两个公开线路、canonical server、speech path、Bearer 鉴权；
- model、input 上限、17 个 voice enum；
- 成功 JSON 结构和临时音频 URL；
- 没有文档化的 speed、format、timestamp 字段；
- 未授权 401 的实际错误结构。

尚未确认：

- 带真实 token 时 `api.v3.cm` alias 与 `api.gpt.ge` canonical 是否在所有模型和所有时段完全等价；
- 除 401 外所有错误码的稳定 JSON schema；
- V-API 是否私下接受未文档化参数；实现不得依赖它们；
- V-API enum 中 `li` 与阿里上游 `Li` 是否都兼容；正式实现先按 V-API 的 `li`，再用真实 token 测试。

## 12. 一手来源

- [V-API Qwen TTS OpenAPI（完整 Markdown 导出）](https://api-gpt-ge.apifox.cn/356760467e0.md)
- [V-API Qwen TTS 在线文档](https://api-gpt-ge.apifox.cn/356760467e0)
- [V-API 公开站点状态与线路列表](https://api.v3.cm/api/status)
- [V-API 公开定价数据](https://api.v3.cm/api/pricing)
- [V-API 模型兼容性说明](https://api-gpt-ge.apifox.cn/5069242m0/)
- [阿里云 Qwen-TTS 音色表](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-list)
- [阿里云非实时语音合成文档](https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide)
