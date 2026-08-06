# 公司网关媒体模型调用故障诊断报告

> 内部诊断材料：包含内网地址、内部网关域名与任务标识，请勿直接公开发布。

日期：2026-07-30
网关：`https://llm-gateway-idc.linshimuye.com`（New API 类中转站）
调用方：Creative Studio（产品素材工作台），运行在内网开发机 `10.20.16.51`
时间说明：下文任务时间采用应用日志中的 UTC 时间（`Z`）。

## 结论摘要

同一环境下的功能性检查未观察到 GPT-5-5、Kimi-K2-6 文本返回异常；本文未附文本任务标识，也不把该背景信息作为媒体链路根因的证据。媒体模型暴露出两类分别出现在输出 URL 和输入 URL 链路的问题；两类问题是否共用同一网关配置或安全组件，仍需管理员通过网关日志确认：

1. **结果下载链路异常（已在 image2-medium 上确认）**：任务已经生成完成，但轮询结果中的 `metadata.url` 指向 `http://localhost:3000`。调用方将该地址改写到真实网关域名后，请求 `/content` 仍返回 403，错误为 `port 3000 is not allowed`。这与网关 Service Address 仍配置为默认本机地址的情况高度一致，但最终需要管理员检查系统配置与网关日志确认。
2. **输入图片 URL 相关的校验或取图失败（已在 Kling、Seedance 上确认）**：调用方传入的是内网 URL `http://10.20.16.51:3000/api/images/...`。Kling 任务提交成功后因 `innerip` 错误失败；Seedance 在提交阶段因拉取图片超时返回 400。现有证据能够确认两个失败都与该内网图片 URL 相关，但不能仅凭调用方响应断定是纯网络不可达，也不能断定拦截发生在网关还是具体上游厂商，需要结合网关日志和对照实验定位。

三个媒体模型的实际失败阶段并不相同：

| 模型 | 提交 | 生成 | 失败阶段 | 当前证据结论 |
|---|---|---|---|---|
| image2-medium | 成功 | 已完成 | 结果下载 | 已确认 `/content` 下载失败；Service Address 为高概率根因 |
| kling-3.0 | 成功并返回任务 ID | 未完成 | 轮询后任务失败 | 已确认内网图片 URL 被拒；具体拦截层待网关日志确认 |
| seedance 2.0 | 失败，HTTP 400 | 未开始 | 提交时拉取输入图 | 已确认远端拉取内网图片超时；具体取图层待网关日志确认 |

## 调用链路与本项目实现

本项目按当前掌握的网关文档实现 `/v1/videos` 异步任务协议：

```text
POST /v1/videos                     提交任务（model/prompt/images/seconds/...）
GET  /v1/videos/<task_id>           轮询任务状态
GET  /v1/videos/<task_id>/content   下载生成结果（Bearer 鉴权）
```

任务完成后，调用方从 `metadata.url` 读取结果地址。若结果地址为相对路径或 loopback 地址，调用方会把它改写到网关 origin；只有下载地址确实属于网关 origin 时才附带 Bearer Key，避免把密钥发送给第三方 CDN。

`images` 字段使用真实 HTTP URL。当前两条视频任务的源图实际解析为：

```text
http://10.20.16.51:3000/api/images/outputs/...
```

该 URL 在公司内网中可由具备相应路由的主机访问，但公网厂商或不具备该内网路由的取图服务无法直接访问。调用方没有使用 Base64 data URL，以避免网关或上游的 URL 长度限制；字段映射仍请管理员按当前部署版本的网关文档复核。

## 故障一：image2-medium 生成完成后结果下载 403

### 已确认事实

任务 `task_M5JJ8NRpeMpLxeB9ch4aDeMdAZOPh736` 在 2026-07-30 11:23 UTC 完成，request_id 为 `202607301123445957590808268d9d6xdkuUnln`。数据库保存的最终轮询响应为：

```json
{
  "id": "task_M5JJ8NRpeMpLxeB9ch4aDeMdAZOPh736",
  "model": "image2-medium",
  "status": "completed",
  "progress": 100,
  "metadata": {
    "url": "http://localhost:3000/v1/videos/task_M5JJ8NRpeMpLxeB9ch4aDeMdAZOPh736/content"
  },
  "request_id": "202607301123445957590808268d9d6xdkuUnln"
}
```

调用方已将 loopback 地址改写为真实网关地址：

```text
https://llm-gateway-idc.linshimuye.com/v1/videos/task_M5JJ8NRpeMpLxeB9ch4aDeMdAZOPh736/content
```

带 Bearer 鉴权请求该地址，手工复现结果为：

```text
HTTP 403
{"error":{"message":"request blocked: port 3000 is not allowed","type":"server_error"}}
```

同一批共四个 image2-medium 任务均进入 `completed`，随后全部在 `/content` 下载阶段失败，并非单任务偶发现象。其余三个 task_id 为 `task_0BDXZhCmkNdqeezUtKHIl7nX1wOjk4Kn`、`task_NhwCCOpo7ScStVAtyfLZWmrvZSvd6ktO`、`task_NrflFYm7pbB36YA60L3tQpuRbQ3U3qQP`。

### 高概率根因

轮询结果中的 `metadata.url` 明确使用 `localhost:3000`，而 `/content` 返回的错误又明确指向端口 3000 被阻止。两项证据与以下链路高度一致：

1. 网关的 Service Address 仍为 `http://localhost:3000`；
2. 网关据此生成或保存了错误的结果 URL；
3. `/content` 处理结果文件时触发了网关自身的 SSRF/端口安全策略。

这是基于调用方证据得出的高概率推断，不代替网关服务器侧确认。

### 需要管理员确认

- 系统设置中的 Service Address 当前是否为 `http://localhost:3000`；
- 任务 `task_M5JJ8NRpeMpLxeB9ch4aDeMdAZOPh736` 的 `/content` 服务端日志；
- `port 3000 is not allowed` 由哪一层组件返回，以及该组件尝试访问的完整目标地址。

### 修复与验收

1. 若 Service Address 确为默认值，将其修改为 `https://llm-gateway-idc.linshimuye.com`；
2. 修改后创建一个新任务，不以旧任务是否恢复作为唯一验收依据；
3. 确认新任务的 `metadata.url` 使用正确 HTTPS 网关域名；
4. 确认带 Bearer 鉴权请求 `/content` 返回 2xx、正确的媒体 `Content-Type` 和非空文件内容。

该配置问题目前只在已完成的 image2-medium 任务上得到直接验证；如果其他媒体任务也使用同一 Service Address 拼接 `/content` 地址，则预计会受到同类影响，但仍需用成功生成的视频任务单独验证。

## 故障二：Kling 3.0 拒绝内网图片 URL

### 已确认事实

任务 `task_vJtkSKGExOXLgI1l5CRWerSNeknicEHJ` 在 2026-07-30 11:41 UTC 提交成功，request_id 为 `202607301141364343520918268d9d6it7ykFiU`，随后轮询返回：

```json
{
  "id": "task_vJtkSKGExOXLgI1l5CRWerSNeknicEHJ",
  "model": "kling-3.0",
  "status": "failed",
  "progress": 100,
  "error": {
    "message": "Input ImageUrl domain may be contain innerip"
  },
  "request_id": "202607301141364343520918268d9d6it7ykFiU"
}
```

调用方为该任务提供的源图 URL 位于 `10.20.16.51:3000`，属于 RFC1918 内网地址。

### 当前判断

错误与输入图片 URL 为内网地址直接相关。它可能来自网关的入参安全检查，也可能来自下游渠道；仅凭调用方响应不能证明 URL 一定已经透传到腾讯侧。

请管理员按 task_id/request_id 检查渠道日志，确认拒绝发生在哪一层，以及该渠道是否支持由网关取图后再上传或转存。

## 故障三：Seedance 2.0 提交时拉取图片超时

### 已确认事实

任务在 2026-07-30 11:41 UTC 发起提交，但没有获得任务 ID。网关在提交请求中直接返回 HTTP 400：

```text
code: fail_to_fetch_task
param: content[0].image_url
message: The parameter content[0].image_url specified in the request is not valid:
         timeout while fetching resource.
request_id: 021785411692594988bfabceb5f218095cf340564d9f29070895e
```

调用方提供的源图同样位于 `http://10.20.16.51:3000/api/images/...`。

### 当前判断

响应表明取图动作发生超时，且任务在生成开始前失败；这与取图方无法访问该内网地址的情况一致，但仅凭超时信息还不能排除源站响应、路由、防火墙或字段映射问题。错误字段形态与 Ark 类上游响应一致，但具体是网关适配层还是厂商侧执行取图，仍需管理员通过 request_id 查日志确认。

## 需要网关侧确认和解决的事项

### P0：修复结果下载地址

- 检查并修正 Service Address；
- 用新建 image2-medium 任务验证 `metadata.url` 与 `/content`；
- 确认同一配置是否也用于视频结果 URL。

### P0 前置：通过部署信息和日志确认渠道边界

这是选择并实施输入图片方案前的必要步骤。请先记录网关版本/构建号、当前 Service Address、反向代理基础地址、模型到渠道的映射，以及配置变更是否需要重启；再使用附录中的 task_id/request_id 回查：

- 图片 URL 在哪一层被校验、拉取或透传；
- Kling 的 `innerip` 错误由网关还是下游返回；
- Seedance 的取图请求由哪一层发起；
- 修改后结果下载是否仍会经过网关内部回源；
- 从网关主机直接请求当前源图 URL 时的状态码、Content-Type、响应长度和耗时；
- 脱敏后的实际请求字段是否符合当前部署版本的渠道契约，尤其是 `images` 到上游图片字段的映射。

### P0：提供上游可访问的输入图片方案

在改动实现前，先使用一张已知可被公网访问、返回正确图片 Content-Type 的 HTTPS 图片分别对 Kling 和 Seedance 做 A/B 对照。如果公网图片成功而当前内网图片失败，即可进一步确认问题位于内网图片交付链路。

推荐按以下优先级选择：

1. **网关提供文件上传接口**：调用方先上传文件，网关返回渠道认可的媒体 ID 或短期签名 URL；
2. **网关代取并转存**：网关从调用方内网地址取图，经过类型、大小和内容校验后，转存到下游可访问的对象存储，再把短期签名 URL 传给渠道；
3. **调用方使用对象存储**：Creative Studio 将输入图片上传到腾讯、火山或双方均可访问的对象存储，使用最小有效期的 HTTPS 签名 URL。

不建议把放行 `10.20.0.0/16` 作为独立修复方案：如果实际取图者位于公网厂商侧，网关白名单不能为其提供内网路由；如果实际取图者是网关，放行整个内网网段还会扩大 SSRF 风险面。任何内网取图能力都应限制到明确主机、端口和路径，并配套重定向、DNS 重绑定、文件类型、文件大小和超时限制。

## 修复验收清单

- [ ] 新建 image2-medium 任务能够完成并下载图片；
- [ ] `metadata.url` 不再包含 `localhost`、`127.0.0.1` 或非预期端口；
- [ ] `/content` 返回 2xx、匹配模型的 `image/*` 或 `video/*` Content-Type、正确文件魔数，并且媒体能够成功解码；
- [ ] Kling 使用新图片方案后完成生成并成功下载结果；
- [ ] Seedance 使用新图片方案后不再出现 `fail_to_fetch_task`，并完成生成及结果下载；
- [ ] 网关日志中不记录 Bearer Key、完整鉴权头或签名 URL 的完整查询串；
- [ ] 临时媒体 URL 有有效期，并且不能用于访问任意内网资源；
- [ ] 下载发生重定向时逐跳复核目标，跨 origin 后绝不继续转发 `Authorization`。

## 附录：诊断标识与复现请求

- 调用机内网 IP：`10.20.16.51`，本地服务端口：3000；
- image2-medium：
  - task_id：`task_M5JJ8NRpeMpLxeB9ch4aDeMdAZOPh736`
  - request_id：`202607301123445957590808268d9d6xdkuUnln`
  - 同批其他失败 task_id：`task_0BDXZhCmkNdqeezUtKHIl7nX1wOjk4Kn`、`task_NhwCCOpo7ScStVAtyfLZWmrvZSvd6ktO`、`task_NrflFYm7pbB36YA60L3tQpuRbQ3U3qQP`
- Kling 3.0：
  - task_id：`task_vJtkSKGExOXLgI1l5CRWerSNeknicEHJ`
  - request_id：`202607301141364343520918268d9d6it7ykFiU`
- Seedance 2.0：
  - task_id：未创建
  - request_id：`021785411692594988bfabceb5f218095cf340564d9f29070895e`

复现 image2-medium 下载 403：

```bash
curl -i \
  -H "Authorization: Bearer <令牌>" \
  https://llm-gateway-idc.linshimuye.com/v1/videos/task_M5JJ8NRpeMpLxeB9ch4aDeMdAZOPh736/content
```
