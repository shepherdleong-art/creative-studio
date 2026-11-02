# 公司网关与 COS 中转

本文记录公司图片/脚本/视频调用经**本机 LiteLLM** 转发时的常驻架构：运行环境、模型尺寸映射、参考图公网交付、首尾帧协议、结果下载与脱敏。修改 `lib/company-gateway-*`、`lib/cos-media.ts`、`lib/local-image-url.ts`、`lib/gateway-media-url.ts`、`lib/image-output-normalize.ts`、公司供应商适配器或 LiteLLM 启停脚本前必读。通用适配器和队列状态机见 `docs/reference/供应商与队列.md`。

## 1. 边界与数据流

公司供应商不是让 Next.js 直接持有公司上游地址并访问公网，而是：

```text
主工作台任务
  → 本机回环 LiteLLM（默认 127.0.0.1:4000）
  → config.yaml 中的公司中转与上游模型
  → 上游需要的图片/视频/音频通过 COS 预签名 URL 交付
  → 任务轮询与结果 URL 归一化
  → 受控下载、图片规整、产物落库
```

边界要点：

- 应用数据库保存公司供应商的模型、启用状态和本机 LiteLLM 地址；公司上游真实密钥在 `config.yaml`，COS 密钥在 `.env.local` 对应的 `CREATIVE_STUDIO_COS_*` 环境变量。
- 公司种子的本地 Bearer 只是非空占位，不是上游密钥，也不能当作可公开的配置模板。
- 图片/视频通用队列没有统一的“所有公司请求先健康检查”包装；**脚本注册入口和公司视频尾帧/七牛可灵传输门禁**会显式检查 sidecar。新增公司链路时需要自行选择并接入正确 gate，不能假设别处已经检查。
- 公司脚本文本调用只需要供应商配置、回环路由和 LiteLLM ready；公司视觉调用另需 COS。直连 `external` 供应商不触发公司 runtime 检查。
- 创作画布还有自己的公司适配器与 prepare/交付流程；本文只把共享尺寸、COS、URL 和下载工具作为边界，不重新定义画布调度器。

## 2. 公司供应商种子与运行时身份

`lib/seed.ts` 以 `COMPANY_LITELLM_BASE_URL` 统一生成 `http://127.0.0.1:<port>`，端口取 `CREATIVE_STUDIO_LITELLM_PORT`，默认 4000。补种只在 canonical ID 缺失时插入，不能用播种覆盖用户已保存的连接、模型或启停状态。

当前 canonical 公司行：

| 类别 | canonical ID | 模型 | 适配器/协议 |
| --- | --- | --- | --- |
| 图片 | `company-gateway-image2-medium` | `image2-medium` | `gateway-task-image` |
| 图片 | `company-gateway-qiniuyun-gpt-image-2-medium` | `qiniuyun/gpt-image-2-medium` | `gateway-task-image` |
| 图片 | `company-gateway-seedream-5-0-pro` | `doubao-seedream-5-0-pro-image` | 公司同步 images/generations 分支 |
| 图片 | `company-gateway-nano-banana-pro` | `nano-banana-3.0` | `gateway-task-image` |
| 图片 | `company-gateway-nano-banana-2` | `nano-banana-3.1` | `gateway-task-image` |
| 视频 | `company-kling-2-5` | `kling-2.5` | `openai-video` |
| 视频 | `company-kling-3-0` | `kling-3.0` | `openai-video` |
| 视频 | `company-qiniuyun-kling-3-0` | `qiniuyun/kling-3.0` | `openai-video` |
| 视频 | `company-seedance-2-0-fast` | `doubao-seedance-2-0-fast-260128` | `openai-video` |
| 视频 | `company-seedance-2-5` | `doubao-seedance-2-5-260628` | `openai-video` |
| 脚本 | `gpt` | `GPT-5-6-Luna-Standard` | `openai-compatible`、`company` scope、支持视觉 |

`litellm-config.example.yaml` 只是模板；实际模型别名必须与本机 `config.yaml` 的 `model_name` 对齐。新增别名还要分别核对适配器、尺寸能力、尾帧 allowlist、用量计价和种子，不应只加一行数据库记录。

## 3. LiteLLM 启停、状态文件与健康检查

### 3.1 启动入口

公司 sidecar 是可选运行环境：组件缺失或启动失败只让公司供应商不可用，不阻塞工作台和外部供应商。

- `npm run dev` 的 `predev` 执行 `bash scripts/start-litellm.sh || echo ...`。
- macOS `start.command` 与 `start-desktop.command` 在 `.venv-litellm/bin/litellm` 和 `config.yaml` 齐备时调用同一 shell 启动器，退出 trap 调 `scripts/stop-litellm.sh`。
- Windows 网页版 `scripts/start-windows.ps1`、桌面版 `scripts/start-desktop-windows.ps1` 调 `scripts/start-stack.ps1 -SkipApp`；桌面免安装模式另传 `-Portable`。
- `start-stack.ps1` 只接受 `-SkipApp`，应用进程由调用方启动。源码模式使用 `.venv-litellm/Scripts/litellm.exe`；免安装模式只使用包内 `python-runtime` 和 `scripts/start-litellm-proxy.py`，并校验 manifest、版本与关键文件哈希，禁止联网修复或回退系统 Python。

两种平台都必须显式以 `--host 127.0.0.1` 启动 LiteLLM，默认端口 4000。启动器会复用“状态文件记录的 PID 仍存活且健康”的既有代理，端口被未知进程占用时失败，不能抢占或误杀；确认端口空闲后才清理陈旧状态。启动后按脚本进行 30 轮健康检查，超时按未就绪处理并回收本轮进程和状态。

运行状态写入 `dataRoot()/storage/run/stack.json`，记录受控 PID、端口、停止脚本、启动时间等，不写 API Key/master key。Windows 通过共享 `stack-state.mjs` 原子写无 BOM JSON；shell 启动器写的状态文件权限为 0600。LiteLLM stdout/stderr 进入 `storage/logs/litellm.out.log` 与 `litellm.err.log`，自定义数据根下也遵循该目录。

### 3.2 只读健康检查

`GET /api/company-provider/health` 只调用 `inspectCompanyProviderRuntime({ root: dataRoot() })`，`Cache-Control: no-store`；不会启动进程、调用模型或探测公司中转站。

`lib/company-provider-runtime.ts` 的判定顺序：

1. 数据根无 `config.yaml`：`not_configured`，不访问网络。
2. 有配置但无 `storage/run/stack.json`：`stopped`，不访问网络。
3. 状态 JSON 无效：`unavailable`，不回显解析错误。
4. 校验状态中的 `litellmPid` 是否仍存活，再请求 `http://127.0.0.1:<proxyPort>/health/liveliness`。默认超时 1500 ms，只有 HTTP 200 算健康；自定义合法代理端口也始终使用回环地址。
5. 全部通过为 `ready`，否则 `unavailable`。

返回仅含状态、受控原因、`proxyAvailable`、`cosConfigured` 和经窄格式校验的 `startedAt`，不返回 PID、密钥、隧道地址或任意文件内容。`cosConfigured` 不影响纯文本 runtime 的 ready 判定，但会影响媒体 gate。

`lib/provider-execution-gate.ts` 另要求 company base URL 是无用户名密码的 HTTP 回环地址（`127.0.0.1`、`localhost` 或 `[::1]`）。它会依次拒绝供应商停用、配置不完整、非回环路由、runtime 未配置/停止/不健康，以及 media 能力下传输不可用。外部供应商只做自身启停/配置检查。

### 3.3 停止链路

- 启动窗口 Ctrl+C/退出 trap、macOS 停止脚本、Windows `stop-stack.ps1` / `stop-windows.ps1` 都会联动回收受控 sidecar。
- 停止时优先按状态 PID 和项目归属校验结束进程；端口属主兜底也只允许本项目进程，绝不能仅凭端口杀未知服务。
- `POST /api/shutdown` 与 SIGTERM/SIGINT 共用 `lib/shutdown.ts` 的幂等 `gracefulShutdown`：先停调度和媒体任务、等待收尾、关闭 SQLite，最后按 `stack.json` 调用受控停止脚本。HTTP 端点总预算 12 秒，随后延迟 100 ms 退出；开发排障不要误触。
- `stopControlledSidecar()` 只接受项目/数据根 `scripts` 目录下名为 `stop-stack.ps1` 或 `stop-litellm.sh` 的已知脚本，状态文件不能成为任意命令执行入口。

## 4. 公司图片协议与传输选择

### 4.1 通用 gateway-task 图片

`lib/providers/gateway-task-image.ts` 对多数公司模型发送：

```text
POST /v1/videos        { model, prompt, images, size, response_format, ... }
GET  /v1/videos/<id>
GET  /v1/videos/<id>/content   （完成态没有结果 URL 时）
```

`images` 始终先放待编辑底图，再放参考图。公司模型 size 先吸附到白名单；`qiniuyun/*` 请求 `response_format='png'`，其他已识别公司图片模型当前请求 `jpeg`。未识别的 gateway 模型保留原 size，不主动添加 response format。

每张入图的实际传输按顺序决定：

1. `qiniuyun/*` 默认先尝试内联 data URL：原图不超过 20 MB 时直接内联；超过则尝试压到 6 MB 预算、最长边 4096、质量 92。可用 `CREATIVE_STUDIO_QINIUYUN_INLINE=0` 关闭，预算可由 `CREATIVE_STUDIO_INLINE_*` 覆盖。
2. 配置 COS 时上传并取预签名 URL；失败可继续后续兼容回退（严格模型除外）。
3. 尝试 `CREATIVE_STUDIO_PUBLIC_BASE_URL` 或自动网卡地址组本机 `/api/images/...` URL。
4. 最后才回退普通 data URL。

队列会记录每张图使用的 `inline-data-url` / `cos-url` / `local-url` / `data-url` 类型，但不得记录完整签名 URL。普通回退不能被误解为所有模型都允许：下列严格模型会在 POST 前失败关闭。

### 4.2 公司 Seedream 5.0 Pro

精确模型 `doubao-seedream-5-0-pro-image` 不走异步任务，而是同步 `POST /v1/images/generations`：

- `image`（单数）仍是底图在前的 URL 数组；`size` 发送 `1K` 或 `2K`，`response_format='url'`、`n=1`。
- 提示词追加由尺寸映射得到的画幅和清晰度；请求使用队列超时，缺省 10 分钟，并每 5 秒报告等待进度。
- 该模型与 Nano Banana 两个别名都要求底图加参考图总数最多 14。
- 结果必须含 `data[0].url`，经网关 URL 归一化后按同步结果下载，不伪造 task ID 或额外轮询。

### 4.3 公司 Nano Banana

`nano-banana-3.0` 与 `nano-banana-3.1` 额外发送 `OutputConfig={ Resolution, AspectRatio }`。这两个模型**必须配置 COS，且底图和每一张参考图都必须实际上传为 `cos-url`**；未配置、任一上传失败或发生通道回退时，任务在提交前失败。不能用本机 URL 或 data URL 绕过。

### 4.4 公司脚本视觉

`lib/script-providers/index.ts` 对 `executionScope='company'` 的视觉调用先过 runtime + media gate，再逐张上传 COS 并使用预签名 URL。默认沿用图片压缩策略；`preserveImageBytes` 时显式 `compress:false`。上传不可用时不发请求。原生 Gemini 适配器只接受 Base64 `inlineData`，不能把这条 URL-only 形式硬套给它。

## 5. 尺寸白名单、吸附与交付尺寸

`lib/company-gateway-size.ts` 同时维护模型能力、名义像素表和吸附算法。不要把应用内 GPT-Image-2 预设直接透传给公司网关。

### 5.1 图片模型能力

| 模型匹配 | 档位 | 比例 | 特殊规则 |
| --- | --- | --- | --- |
| 精确 `doubao-seedream-5-0-pro-image`、`doubao-seedream-5-0-pro-260628` | 1K/2K | 全部 8 种 | 使用方舟专用像素表；`nativeDelivery` |
| 精确 `nano-banana-3.0`、`nano-banana-3.1` | 1K/2K/4K | 全部 8 种 | `nativeDelivery` |
| `qiniuyun/gpt-image-2*` | 2K/4K | 1:1、3:4、4:3、16:9、9:16 | 排除 `4K:3:4`；`nativeDelivery` |
| `image2-*` | 1K/2K/4K | 1:1、3:4、4:3、16:9、3:2、2:3、21:9 | 不支持 9:16；`nativeDelivery` |
| 其他含 `seedream` + `pro` 的公司模型 | 1K/2K | 全部 8 种 | 普通交付 |
| 其他含 `seedream` 的公司模型 | 2K/3K/4K | 全部 8 种 | 普通交付 |

“全部 8 种”指 `1:1、3:4、4:3、16:9、9:16、3:2、2:3、21:9`。`gpt-image-2` 等非公司模型不由这张表处理。

通用图片名义表如下，每格为 `比例=宽x高`：

| 档位 | 尺寸 |
| --- | --- |
| 1K | `1:1=1024x1024`；`3:4=1024x1366`；`4:3=1366x1024`；`16:9=1820x1024`；`9:16=1024x1820`；`3:2=1536x1024`；`2:3=1024x1536`；`21:9=2390x1024` |
| 2K | `1:1=1440x1440`；`3:4=1440x1920`；`4:3=1920x1440`；`16:9=2560x1440`；`9:16=1440x2560`；`3:2=2160x1440`；`2:3=1440x2160`；`21:9=3360x1440` |
| 3K | `1:1=1920x1920`；`3:4=1920x2560`；`4:3=2560x1920`；`16:9=3414x1920`；`9:16=1920x3414`；`3:2=2880x1920`；`2:3=1920x2880`；`21:9=4480x1920` |
| 4K | `1:1=2160x2160`；`3:4=2160x2880`；`4:3=2880x2160`；`16:9=3840x2160`；`9:16=2160x3840`；`3:2=3240x2160`；`2:3=2160x3240`；`21:9=5040x2160` |

Seedream Pro 专用表：

| 档位 | 尺寸 |
| --- | --- |
| 1K | `1:1=1024x1024`；`3:4=864x1152`；`4:3=1152x864`；`16:9=1280x720`；`9:16=720x1280`；`3:2=1248x832`；`2:3=832x1248`；`21:9=1512x648` |
| 2K | `1:1=2048x2048`；`3:4=1728x2304`；`4:3=2304x1728`；`16:9=2848x1600`；`9:16=1600x2848`；`3:2=2496x1664`；`2:3=1664x2496`；`21:9=3136x1344` |

### 5.2 图片吸附算法

- 比例按宽/高的对数距离取最近项，并列时偏好横向。
- 应用内 GPT-Image-2 预设可直接识别其 1K/2K/4K 档位；档位不被模型允许时按档位序就近，平局取低档。
- 非预设像素尺寸按目标总像素与各名义格的像素量就近选档；`auto` 或无法解析时默认 1:1、2K，再钳制到模型能力。
- 命中排除格时，先在同档位寻找宽高都能覆盖目标框的跨比例 donor，以生成后居中裁切且零放大；没有可裁 donor 才在同比例下换档。当前 `qiniuyun 4K 3:4` 可由 `4K 9:16 = 2160x3840` 生成后裁到名义 `2160x2880`。
- `companyImageOutputConfig()` 返回的是名义 `Resolution` / `AspectRatio`，不是把应用预设像素改名；`companyImageDeliverySize()` 返回最终用于比例裁齐的名义格尺寸。

### 5.3 视频模型能力与尺寸

视频按首帧实际宽高选择最近比例，比例未知时调用方通常省略 size；档位按 `1K → 720P → 4K` 偏好选择模型允许的第一项，不随源图分辨率自动上浮。固定档模型自然只用其唯一档。

| 模型 | 档位与比例 | 输出约束 |
| --- | --- | --- |
| `kling-2.5` | 仅 1K 名义档；3:4、4:3、16:9、9:16 | 另送 `OutputConfig.Resolution='1080P'` 与 Duration；只支持 5/10 秒 |
| `qiniuyun/kling-3.0` | 仅 1K；同四种比例 | 首帧尺寸必须可读；以 1K 名义 size 锁输出比例 |
| 其他 `kling-*`（非 Omni） | 720P/1K/4K；同四种比例 | 通常优先 1K |
| Kling Omni | 720P/1K；仅 3:4、4:3 | 不发送公司智能分镜字段 |
| 精确 `doubao-seedance-2-0-260128`；`doubao-seedance-2-5*` | 固定 1080P；16:9、4:3、1:1、3:4、9:16、21:9 | 使用方舟 1080p 表 |
| 精确 `doubao-seedance-2-0-fast-260128` | 固定 720P；同六种比例 | 使用 Fast 专用 720p 表 |
| 其他 Seedance | 无公司 size 映射 | 保留上游默认，不套可灵表 |

通用视频表：

| 档位 | 尺寸 |
| --- | --- |
| 720P | `3:4=720x960`；`4:3=960x720`；`16:9=1280x720`；`9:16=720x1280` |
| 1K | `3:4=1024x1366`；`4:3=1366x1024`；`16:9=1820x1024`；`9:16=1024x1820` |
| 4K | `3:4=2160x2880`；`4:3=2880x2160`；`16:9=3840x2160`；`9:16=2160x3840` |
| 1080P | `16:9=1920x1080`；`4:3=1664x1248`；`1:1=1440x1440`；`3:4=1248x1664`；`9:16=1080x1920`；`21:9=2206x946` |
| Fast 720P | `16:9=1280x720`；`4:3=1112x834`；`1:1=960x960`；`3:4=834x1112`；`9:16=720x1280`；`21:9=1470x630` |

时长另由 `lib/video-duration.ts` 统一校验：公司 Kling 3.0/七牛可灵为 3–15 秒整数，Seedance 2.0 为 4–15 秒，Seedance 2.5 为 4–30 秒；非法值不能静默截断。

## 6. COS 上传、查重与预签名

### 6.1 配置与签名

`lib/cos-media.ts` 不新增 COS SDK，直接用 `node:crypto` 实现 COS XML API 的 `q-sign-algorithm=sha1` 签名和 `fetch` 请求。

| 环境变量 | 当前默认值/用途 |
| --- | --- |
| `CREATIVE_STUDIO_COS_SECRET_ID`、`..._SECRET_KEY`、`..._DOMAIN` | 三项齐全才启用；DOMAIN 可为自定义/CDN 域名或默认端点 |
| `CREATIVE_STUDIO_COS_SIGN_HOST` | 可选签名 Host；CDN 回源改写 Host 时设为源站端点，URL 仍走 DOMAIN |
| `CREATIVE_STUDIO_COS_PREFIX` | 默认 `ref-images/`，自动补末尾 `/` |
| `CREATIVE_STUDIO_COS_URL_TTL_SEC` | 预签名 GET 默认 86400 秒（24 小时） |
| `CREATIVE_STUDIO_COS_COMPRESS` | 默认开启；`0` 或 `false` 关闭 |
| `CREATIVE_STUDIO_COS_MAX_BYTES` | 默认 2 MiB，超过才考虑压缩 |
| `CREATIVE_STUDIO_COS_MAX_DIM` | 默认 4096，任一边超过才考虑缩放 |
| `CREATIVE_STUDIO_COS_QUALITY` | 默认 90，合法值钳制 1–100 |
| `CREATIVE_STUDIO_COS_VIDEO_MAX_BYTES` | 视频首帧/尾帧默认 4,800,000 字节 |
| `CREATIVE_STUDIO_COS_VIDEO_MAX_DIM` | 视频帧默认 4096 |
| `CREATIVE_STUDIO_COS_VIDEO_QUALITY` | 视频帧默认 95 |

对象键为 `prefix + 实际上传字节的 SHA-256 + 扩展名`，因此文件与内存 buffer 共用内容去重空间。签名 URL 缓存在进程内，距离到期不足 1 小时就视为不可用并重签。

查重使用带签名的 **GET + `Range: bytes=0-0`**，不是 HEAD：200/206 视为对象存在并跳过 PUT，404 才上传，其余状态失败。查重超时 30 秒，PUT 超时 120 秒。`SIGN_HOST` 只参与签名，不能把实际请求改成另一个业务域名。

### 6.2 压缩策略

- 只有 JPEG/PNG/WebP 且“字节超预算或边长超预算”时才处理；`compress:false` 完全保留字节。
- 缩放使用 `fit:'inside'` 且不放大。JPEG 保持 JPEG，WebP 保持 WebP；PNG 有 alpha 时转 WebP，否则转 JPEG。
- 压缩结果不比原图小、格式不适用或 sharp 失败时回退原字节，不让压缩本身阻断上传；后续 COS 查询/PUT 失败仍要抛错。
- 视频首帧/尾帧使用独立的 4.8 MB/4096/q95 阈值，尽量避免无必要降质。压缩只影响 COS 中转副本，不改本地原图。

COS 错误只保留 HTTP 状态和可操作提示，不返回 SecretKey 或签名串。签名参数、预签名 URL 和鉴权头不得写入新日志。

## 7. 本机 URL 回退与图片路由边界

`lib/local-image-url.ts` 只把 `dataRoot()/storage` 内的文件映射为 `/api/images/<逐段编码相对路径>`，目录外文件返回 null。

地址来源：

1. 显式 `CREATIVE_STUDIO_PUBLIC_BASE_URL`，来源标为 `configured`；
2. 否则取第一张非内部 IPv4 网卡与 `PORT`（默认 3000），来源标为 `network`。

`app/api/images/[...path]/route.ts` 只允许 `inputs`、`outputs`、`references`、`originals`、`processed` 下的 PNG/JPEG/WebP，拒绝数据库、日志、其他扩展和目录穿越。

普通公司视频首帧在 COS 未配置或上传失败后可尝试该兼容通道；但没有可解析 URL，或自动探测到私网/回环地址时，提交前报错。显式 configured 地址不会被这条自动私网检查拒绝，因此配置者必须自行保证上游可达。**它不是为了把工作台暴露到公网，也不是严格链路的替代方案。**

部署红线仍是：Next.js 与 LiteLLM 默认只监听回环，不能把本机服务开放到公网；公网素材交付只走 COS。公司尾帧、七牛可灵、Nano Banana 和公司脚本视觉等严格通道不得回退到本机/公网自建 URL。

## 8. 视频首帧与尾帧 fail-closed

### 8.1 普通首帧

`openai-video` 首帧优先按视频帧压缩策略上传 COS；普通模型失败时可回退本机 URL。请求中的首帧位于 `images[0]`，提交与轮询单次超时分别为 120 秒和 30 秒。

`qiniuyun/kling-3.0` 即使没有尾帧，也必须先通过“回环 LiteLLM + sidecar 健康 + COS”门禁；COS 上传失败、未返回 URL 或首帧尺寸不可读时均不得 POST。其请求另含 `mode='pro'`、`generate_audio=true`，智能分镜 boolean 可按任务显式关闭。

### 8.2 尾帧精确协议

只有 `lib/company-gateway-tail-frame.ts` 中精确 allowlist 的六个公司模型别名可带尾帧。所有公司尾帧任务都执行：

1. `assertCompanyTailFrameTransport()` 校验回环 LiteLLM、受控 PID/健康和 COS 可用。
2. 首帧与尾帧分别上传 COS，使用视频帧压缩阈值。
3. 任一 gate、上传或 URL 结果失败，立即报错；不得退回本机 URL，不得发出 `POST /v1/videos`。

| 精确模型 | 请求映射 |
| --- | --- |
| `kling-2.5`、`kling-3.0` | `images` 只放首帧；尾帧用 `LastFrameUrl`；`OutputConfig` 带 Duration、`Resolution='1080P'`，可读尺寸时带吸附后的 AspectRatio；不要再把尾帧塞入 `images[1]` |
| `qiniuyun/kling-3.0` | `images` 只放首帧；尾帧用 `end_image_url`；不使用腾讯 `LastFrameUrl` 分支 |
| `doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-5-260628` | `images=[首帧, 尾帧]`；不加 LastFrameUrl/end_image_url；首帧尺寸可读时按对应 Seedance 表送 size |

公司 Seedance 2.5 双图当前按“双参考图 + 提示词”合同处理，不能宣称与方舟显式 `first_frame/last_frame` role 相同的像素级锚定；首帧尺寸可读时，其 size 仍按 1080p 表发送。方舟直连尾帧模型与协议清单见供应商参考，不要把两个 allowlist 合并。

## 9. 结果 URL、受控下载与图片规整

### 9.1 网关 URL 归一化

`normalizeGatewayResultUrl()` 将相对路径和 `localhost/127.0.0.1/::1` 的结果地址改写到实际网关 origin，避免把网关返回的 localhost 当成工作台自身。其他 CDN 地址保持原样。完成态没有 URL 时，图片与视频都使用**提交时的原始 task ID** 拼 `/content`，不能依赖轮询响应可能缺失路由信息的 ID。

### 9.2 下载鉴权与重试

`downloadGatewayMedia()` 的行为：

- 手动处理最多 5 次重定向；每一跳重新判断 URL 是否仍属于网关 origin，只有同源才附 Bearer。跳到 CDN 后立即去掉 Authorization。
- 无 HTTP 状态的网络异常最多尝试 3 次，退避 1 秒、2 秒；HTTP 错误、重定向问题和 JSON 错误体不做这类重试。
- HTTP 200 但内容是 JSON 错误（包括 content-type 不是 JSON、首字节为 `{` 的情况）也判失败，不能把错误页保存成图片或 MP4。
- 错误文本和日志 URL 经脱敏；`redactMediaUrlForLog()` 只保留 origin/path，查询串整体替换。

主队列在远端已成功、本地下载失败时写 `failed` / `download_failed` 并保留远端地址，不自动重新提交。视频预览生成是后续独立步骤，不应混淆为下载失败。

### 9.3 普通尺寸规整与 nativeDelivery

- 普通模型：`normalizeGeneratedImageToSize()` 以任务原始 `job.size` 为目标，使用 sharp `cover` 居中裁切/缩放到精确像素；目标为 `auto` 或不可解析、源尺寸已一致时保留原图。发生重编码时输出 PNG。
- `nativeDelivery` 模型：`normalizeGeneratedImageToNativeRatio()` 只按名义格比例取最大内接矩形并居中裁切，**绝不缩放**。源比例一致时保留网关原生像素和原始字节；比例不一致才裁齐并重编码为 PNG。
- 排除格 donor 也按目标名义格比例裁切，不再放大到应用预设。落盘扩展名与 `image_assets.mimeType` 按最终真实格式选择 `.png`、`.jpg` 或 `.webp`，不能一律写成 PNG。

队列与图片 `resume-poll` 必须选择同一套规整规则，避免补抓产物和正常队列产物尺寸不同。

## 10. 日志脱敏与安全红线

现有三层工具各有职责：

- `lib/log-sanitize.ts` 的 `sanitizeMessage()` 是 `writeLog()` 的统一出口，处理 URL 用户信息/query/hash、常见 API Key/Bearer/Authorization、secret/signature 字段和部分长密钥形态，再同时写数据库与 `storage/logs/`。
- `redactMediaUrlForLog()` 用于需要保留媒体 origin/path 的日志；`sanitizeGatewayMediaDiagnostic()` 另处理 JSON 敏感字段、嵌入 URL 的完整 query、原始及 URL 编码后的已知 API Key 和 Bearer。
- `openai-video` 在持久化网关原始响应前也做诊断脱敏；脚本 OpenAI-compatible 的持久化错误使用 `safeProviderErrorHint()` 的本地分类标签，不直接保存可能回显提示词、密钥或签名 URL 的上游错误体。

新增代码必须遵守：

- 不打印请求头、SecretId/SecretKey、Bearer、完整鉴权串、COS 签名参数或带 query 的预签名 URL；不要把“已截断”当作脱敏。
- 公司 `config.yaml`、`.env.local`、数据库密钥均不得进入健康响应、供应商元数据或前端调试面板。
- Next.js 与 LiteLLM 不暴露公网；公网交付只走 COS。严格模型的 gate 失败必须发生在任何生成 POST 之前。
- 不把签名 URL 当长期资产地址；任务完成后应下载并保存本地结果，预签名只负责上游取图期间可达。

## 11. 关键文件与相关 API

| 范围 | 文件/端点 |
| --- | --- |
| 尺寸与尾帧 | `lib/company-gateway-size.ts`、`lib/company-gateway-tail-frame.ts`、`lib/video-tail-frame.ts` |
| 图片公司适配 | `lib/providers/gateway-task-image.ts` |
| 视频公司适配 | `lib/video-providers/openai-video.ts`、`lib/video-multi-shot.ts` |
| COS 与本地 URL | `lib/cos-media.ts`、`lib/local-image-url.ts`、`app/api/images/[...path]/route.ts` |
| 结果下载 | `lib/gateway-media-url.ts`、`lib/media-download-policy.ts` |
| 图片交付 | `lib/image-output-normalize.ts`、正常队列与 `app/api/jobs/[id]/resume-poll/route.ts` |
| runtime/gate | `lib/company-provider-runtime.ts`、`lib/provider-execution-gate.ts`、`app/api/company-provider/health/route.ts` |
| 启停 | `scripts/start-litellm.sh`、`stop-litellm.sh`、`start-stack.ps1`、`stop-stack.ps1`、`lib/shutdown.ts` |
| 种子与配置 | `lib/seed.ts`、`litellm-config.example.yaml`、实际本机 `config.yaml`（私密配置，不提交） |

## 12. 测试入口

按改动范围运行；默认测试使用 mock/临时目录，不等于真实公司网关或 COS 验收：

```bash
node scripts/company-gateway-size.test.ts
node scripts/gateway-task-image.test.ts
node scripts/openai-video-adapter.test.ts
node scripts/video-tail-frame-validation.test.ts
node scripts/video-tail-frame-api.test.mjs
node scripts/cos-media.test.ts
node scripts/local-image-url.test.ts
node scripts/gateway-media-url.test.ts
node scripts/media-download-policy.test.ts
node scripts/image-output-normalize.test.ts
node scripts/company-provider-runtime.test.ts
node scripts/provider-execution-gate.test.ts
node scripts/company-provider-seed.test.ts
node scripts/company-provider-startup.test.mjs
node scripts/litellm-macos-startup.test.mjs
node scripts/graceful-shutdown.test.ts
```

`COS_LIVE_TEST=1 node scripts/cos-media.test.ts` 是可选真实 COS 往返，会在已配置账号下写入测试对象；不属于默认离线回归，运行前必须确认目标 bucket 与权限。
