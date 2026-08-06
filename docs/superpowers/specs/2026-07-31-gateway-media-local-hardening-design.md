# 网关媒体链路本地加固设计

日期：2026-07-31

## 背景与证据

Creative Studio 通过公司 New API 类网关的 `/v1/videos` 协议调用 image2-medium、Kling 3.0 与 Seedance 2.0。运行记录和网关模型页截图共同确认：

- image2-medium 已生成完成，但结果 URL 被生成为 `http://localhost:3000/.../content`，改写到真实网关后下载返回 403；
- Kling 与 Seedance 的 `images` 都是 URL 数组并映射到上游字段；当前自动生成的 `http://10.20.16.51:3000/api/images/...` 分别被判定为 innerip 和拉取超时；
- 网关页面没有展示 Base64 或文件上传型输入参数；
- 网关服务端配置、上传能力和渠道取图方式不能由本仓库修复。

## 目标

1. `openai-video` 不再自动提交已知不可用的内网 URL 或 data URL，避免无效任务和潜在扣费。
2. 网关媒体下载失败时保留 HTTP 状态和脱敏后的响应摘要，不再只得到 `null`。
3. 下载发生重定向时逐跳决定是否附带 Bearer，跨网关 origin 不携带鉴权。
4. 图片、视频以及补抓流程使用一致的下载诊断结果；远端已完成但下载失败时不重新提交生成任务。

## 非目标

- 不修改网关 Service Address 或网关渠道配置；
- 不新增对象存储、反向代理、隧道或文件上传服务；
- 不新增数据库字段、迁移或设置页；
- 不改变 `gateway-task-image` 的内网 URL 行为，因为 image2 已证明网关能够读取调用机图片；
- 不承诺修复 Kling/Seedance，只有配置了下游可访问的媒体地址后才能端到端恢复。

## 设计

### 1. 视频输入 URL 预检

`lib/local-image-url.ts` 在保留 `resolvePublicImageUrl()` 兼容接口的同时，新增带来源的解析结果：`configured` 表示来自 `CREATIVE_STUDIO_PUBLIC_BASE_URL`，`network` 表示自动探测网卡。

`openai-video` 只接受以下输入：

- 显式配置产生的 URL：按用户配置直接使用，即使它仍是内网地址；
- 自动探测产生且主机不是 loopback、link-local 或 RFC1918 的 URL。

如果文件不在 `storage/`、没有可用 URL，或者自动探测结果属于私网，适配器在调用 `fetch` 前抛出中文可操作错误，要求配置一个下游能访问的 `CREATIVE_STUDIO_PUBLIC_BASE_URL`。视频网关不再回退 data URL。图片网关继续保持现状。

### 2. 结构化下载结果

`downloadGatewayMedia()` 返回判别联合：

- `{ ok: true, buffer }`；
- `{ ok: false, status?, errorMessage }`。

失败摘要最多保留 500 字符，并脱敏 API Key、Bearer、常见 token/signature 查询参数。日志显示的 URL 去除查询串，数据库中的远端 URL 字段仍可保留原始值供本地补抓。

### 3. 重定向与鉴权

下载使用 `redirect: 'manual'`，最多跟随 5 跳。每一跳重新比较目标 URL 与网关 origin：只有目标仍属于网关时才附带 Bearer；跳到 CDN 或其他 origin 时不带鉴权。相对 `Location` 按当前 URL 解析。

### 4. 调用方行为

- 图片主队列：远端完成后的下载失败写入 `download_failed`，错误信息包含结构化诊断，不触发重新生成；
- 图片补抓：下载失败写入 `needs_check` 与诊断信息，允许稍后再次补抓，但不重新提交；
- 视频主队列：`openai-video` 使用统一下载器，失败写入 `download_failed`，不重新生成；其他原生视频供应商保持原下载逻辑；
- 视频补抓：`openai-video` 使用统一下载器并向 API 返回脱敏错误；
- 所有日志 URL 使用无查询串形式。

## 测试与验收

- 失败测试先证明：视频会提交 data URL、下载 403 只返回 null、跨域重定向行为未被显式约束；
- 单元测试覆盖显式 URL、自动私网拒绝、无 URL 拒绝、403 诊断、敏感信息脱敏、同源鉴权、跨域重定向去鉴权和重定向上限；
- 定向运行 `local-image-url`、`openai-video-adapter`、`gateway-media-url`、`gateway-task-image` 测试；
- 最后运行 `npm run lint` 与 `npm run build`。

## 安全边界

错误和日志不得包含 API Key、Authorization 值或签名 URL 完整查询串。显式配置的公网媒体地址由部署者负责可达性与访问控制；本地预检不主动探测外部 URL，也不会上传文件。
