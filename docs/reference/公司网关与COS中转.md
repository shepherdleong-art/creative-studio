# 公司模型网关与 COS 中转 参考

> 从 `AGENTS.md` 下沉的实现细节。**动公司网关、尺寸吸附、参考图交付、尾帧或 COS 相关代码前读这里。**
> 本文里的像素组合、字节阈值、探测日期都是拿真任务跑出来的实测结论，不是推断——修改前先确认是否重新实测过。

## 启动联动（macOS / Windows 源码运行）

公司网关联动（macOS / Windows 源码运行）：`.venv-litellm` 与 `config.yaml` 齐备时，macOS 的 `start.command` 与 `npm run dev` 的 `predev` 钩子都经 `scripts/start-litellm.sh`、Windows 的 `start-windows.cmd`（桌面壳）与 `scripts/start-windows.ps1`（dev server）都经 `scripts/start-stack.ps1 -SkipApp` 拉起 LiteLLM（端口 4000，启动参数必须显式 `--host 127.0.0.1`）；依赖锁定在 `requirements-litellm.txt`，组件缺失或 sidecar 失败只禁用公司供应商，不阻塞工作台。Windows 免安装包不走 venv：`start-stack.ps1 -Portable` 用包内 `python-runtime\python.exe scripts\start-litellm-proxy.py --config config.yaml --host 127.0.0.1 --port 4000` 启动，`stack.json` 记录 `litellmRuntime` 与实际解释器路径，`stop-stack.ps1` 按 PID + 路径归属停止。参考图的公网交付走腾讯云 COS（`CREATIVE_STUDIO_COS_*`，见 `lib/cos-media.ts`）。安全约束：本机服务（app 与代理）不得暴露到公网，公网交付只走 COS。两平台停止脚本、启动窗口 Ctrl+C、以及 UI 的关闭按钮（`/api/shutdown` 读取 `storage/run/stack.json` 的受控 `stopScript`）都会把代理一并关闭。状态文件：`storage/run/stack.json`（无 BOM JSON）。注意 `scripts/*.ps1` 必须保存为 **UTF-8 带 BOM**（PS 5.1 按 ANSI 读无 BOM 的中文会解析失败）。

macOS 启动器只对 LiteLLM 子进程清除大小写两套 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，避免 Codex 或终端的公网代理接管公司网关请求；这不会改变 Codex、Next 或父 shell 的代理环境。若代理客户端启用 TUN/全局路由，还必须在客户端把公司网关域名及所需私网网段置于高优先级 `DIRECT` 规则，因为进程环境变量无法绕过系统路由层截流。

`config.yaml` 的请求可靠性参数必须放在 `router_settings`，不能写成顶层字段：当前生产值为 `num_retries: 0`、`timeout: 110` 秒。应用侧超时是 120 秒；代理必须先终止上游并返回，避免客户端先断开后 LiteLLM 仍占用公司并发。应用可按业务语义做一次顺序重试，LiteLLM 内部不得再叠加不可见重试。`scripts/litellm-router-timeout.test.mjs` 用本机假上游验证单次请求及超时断连，不访问公司网络。

## `company-gateway-size.ts` — size 白名单、吸附与裁切映射

- `company-gateway-size.ts` — 公司模型网关（llm-gateway-idc.linshimuye.com，经本地 LiteLLM 代理转发，代理配置在 `config.yaml`）的 size 白名单与吸附逻辑；`gateway-task-image` / `openai-video` 适配器仅对公司模型把请求 size 吸附到文档允许的像素组合并补 `response_format`（qiniuyun/* 实测收 `png` 并回无损 PNG——2K 3:4 约 2.8MB，而 jpeg 仅 ~300KB 压缩发糊，2026-08-21 真实任务验证；image2/seedream 维持历史 `jpeg`）；网关完成态常不带产物 URL，两个适配器都会回退用**提交时返回的原始任务 id** 拼 `/v1/videos/<id>/content` 下载（轮询响应里的 id 可能丢 model_id，拼地址不要用它）。`qiniuyun/gpt-image-2-medium`（2026-08-21 逐格真实任务探测）放行 2K×{1:1,3:4,4:3,16:9,9:16} + 4K×{1:1,4:3,16:9,9:16}，并经 `CompanyModelCaps.exclude` 单格排除 4K 3:4：1K 档被网关映射成 1080 类视频制式尺寸、4K 3:4 映射成 2160x2878，均不满足上游「宽高 16 整除」被拒；3K 档与 3:2/2:3/21:9 提交即拒。命中排除格时优先「裁切映射」——同档位找能居中裁切覆盖目标框的跨比例好格（4K 3:4 → 4K 9:16 的 2160x3840，交付端 normalize 裁回 3:4 名义格 2160x2880，真 4K 级画质），没有可裁格才同比例就近换档。开启 `nativeDelivery` 的公司模型（目前 qiniuyun/* 与 image2-*，均逐格实测过）按网关原生像素交付：`queue.ts` 的规整目标用 `companyImageDeliverySize`（名义格子比例）只裁齐比例、绝不缩放——同比例白赚网关额外像素（image2 2K 3:4 实返 1920x2560），比例略偏的裁齐（1K 3:4 → 1024x1366）；新建项目页清晰度选项对这类模型只展示 1K/2K/4K 档位与比例，不展示具体像素。

## `cos-media.ts` — 腾讯云 COS 参考图中转

- `cos-media.ts` — 腾讯云 COS 参考图中转。配置 `CREATIVE_STUDIO_COS_SECRET_ID` / `CREATIVE_STUDIO_COS_SECRET_KEY` / `CREATIVE_STUDIO_COS_DOMAIN`（可选 `CREATIVE_STUDIO_COS_PREFIX` 默认 `ref-images/`、`CREATIVE_STUDIO_COS_URL_TTL_SEC` 默认 86400、`CREATIVE_STUDIO_COS_SIGN_HOST`）后，`gateway-task-image` / `openai-video` 适配器提交任务时把参考图按内容 SHA-256 命名上传（GET `Range: bytes=0-0` 查重跳过重复上传）并生成 24h 预签名 GET URL 传给网关；手写 `q-sign-algorithm=sha1` 签名（`node:crypto`，零新增依赖），上传/下载都走配置的自定义域名。上传前默认压缩（`CREATIVE_STUDIO_COS_COMPRESS=0` 关闭；`CREATIVE_STUDIO_COS_MAX_BYTES` / `MAX_DIM` / `QUALITY` 可调，默认 2MB / 4096px / 90）；视频首帧/尾帧默认只有超过 4.8MB 才压缩（`CREATIVE_STUDIO_COS_VIDEO_MAX_BYTES` / `VIDEO_MAX_DIM` / `VIDEO_QUALITY` 可调，默认 4.8MB / 4096px / q95，经 `getCosVideoCompressOptions()` 读取；腾讯尾帧 LastFrameUrl 图片限 5M、首帧 FileInfos 限 10M，超过会在任务创建前 400，阈值取更小者留余量），避免视频生成起点糊掉；压缩只影响发给上游的 COS 中转副本，本地成品文件不受影响。注意 CDN 自定义域名回源会把 Host 改写成源站默认端点（如 `<bucket>.cos.ap-guangzhou.myqcloud.com`），且会把 HEAD 改写为 GET——此时必须把 `CREATIVE_STUDIO_COS_SIGN_HOST` 设为源站端点用于签名，查重不能用 HEAD。COS 未配置或上传失败时适配器回退 `local-image-url` 的本机 URL 逻辑。压缩核心导出为 `compressImageToBudget`，供 `gateway-task-image` 的 qiniuyun 免 COS 内联通道复用。密钥只放 `.env.local`，日志不得打印签名参数。公司供应商的脚本视觉调用（`completeJson` 带图片）也走这条受控传输：`tryUploadBufferToCosAndSign` 把内存图片上传 COS 后改用预签名 URL 发给模型，不内联 base64；COS 未配置时门禁（`provider-execution-gate.ts` 的 `transport_unavailable`）失败关闭。

## `image-output-normalize.ts` — 原生像素交付

- `image-output-normalize.ts` — 生成图与目标尺寸不一致时用 sharp 居中裁切并记日志。开启 `nativeDelivery` 的公司模型（qiniuyun/* 与 image2-*）只按 `companyImageDeliverySize` 推出的名义格比例居中裁切、绝不缩放：同比例即原样交付（image2 常返回比名义格更大的图，白赚像素），比例略偏的裁齐（image2 1K 3:4 实返 1024x1376 → 1024x1366），排除格 donor 裁回名义格比例；其余模型（seedream 等）仍规整到 `job.size`。normalize 结果带 `format`（原样交付为源格式如 jpeg，重编码后恒为 png），`queue.ts` 按它定落盘扩展名与落库 MIME——原生交付不再把 jpeg 字节写成 .png 文件。

## `local-image-url.ts` — 本地图片转 HTTP URL（COS 未配置时的回退）

- `local-image-url.ts` — 把 `storage/` 下的本地图片转成 `/api/images/...` 的 HTTP URL，供只接受真实 URL 的网关上游（腾讯等）拉取；地址默认自动探测（第一张非内部 IPv4 + `PORT`/3000），可用 `CREATIVE_STUDIO_PUBLIC_BASE_URL` 覆盖，探测不到时调用方回退 data URL。

## `gateway-media-url.ts` — 网关结果 URL 归一化与带鉴权下载

- `gateway-media-url.ts` — 网关结果 URL 归一化（把网关误配的 localhost/相对路径结果地址改写到网关 origin）与带鉴权下载（仅当目标指向网关 origin 才附 Bearer）。

## `seed.ts` — 公司供应商开箱即用补种

- `seed.ts` — 启动时向 `video_providers` 等表写入内置供应商预设。公司供应商（图片 `image2-medium`、视频 `kling-3.0` / `doubao-seedance-2-0-fast-260128`、脚本 `GPT-5-6-Luna-Standard`）以 `http://127.0.0.1:4000` + 占位 Key 开箱即用补种（本机 LiteLLM 不校验调用方 Bearer，上游真实 Key 由 `config.yaml` 持有）；已有同模型手工配置时不重复补种，已有用户配置不被覆盖。

## 红线（这几条同时留在 AGENTS.md）

- 本机服务（app 与 LiteLLM 代理）**不得暴露到公网**，公网交付只走 COS。
- COS 密钥只在 `.env.local`，签名参数绝不进日志。
- 公司尾帧必须走本机 LiteLLM + 两帧都用 COS 预签名 URL；任一 gate 或上传失败必须在 POST 前 fail closed。
- 未配置 COS 时，公司脚本供应商的视觉调用由 `provider-execution-gate.ts` 以 `transport_unavailable` fail closed，不许退回内联 base64。
