# Seedream 5.0 Pro 方舟直连接入

## 范围与配置

新增图片供应商「Seedream 5.0 Pro（方舟直连）」，旧图片工作台与创作画布均可使用。供应商 ID 为 `ark-seedream-5-0-pro`，接口类型 `ark-images`，模型 `doubao-seedream-5-0-pro-260628`，地址 `https://ark.cn-beijing.volces.com/api/v3`。公司 Seedream 别名与 LiteLLM 路由保持原样。

按用户本次授权，仅在当前主项目本地数据库中复用 `jimeng-2-0` 的方舟 Key 并启用新增图片供应商；该来源正是画布 Seedance 2.0／2.5 共用直连配置。Key 未输出、未写进代码或文档。通用播种只添加无 Key、默认关闭的预设，不自动复制其他用户的凭据，不覆盖已有设置。直连单价暂留空，未沿用公司网关价格。

## 协议与限制

- 文生图、图生图均提交同步 JSON `/images/generations`；参考图用 `image` 数组内联 data URL，提示词原样发送，不加公司前缀。
- 最多 10 张参考图，当前应用支持 PNG／JPEG／WebP；单图不超过 30MB，长宽均大于 14px，像素不超过 3600 万，比例在 1:16–16:1。
- 画布与旧工作台开放 1K／2K，采用明确像素尺寸；适配层也接受官方 1.5K，但本次未新增统一 UI 档位。总输出像素为 921600–4624220，工作台 21:9 的 1456×624 低于最低预算，提交时改为官方 1512×648。4K 在界面限制并于提交前拒绝。
- 请求 URL 返回、PNG 格式、无水印，不发送不受支持的 `quality`、`n`、组图或流式字段。本次不开放图层拆分、透明背景及交互编辑专用参数。
- 图片等待默认 600 秒；旧队列仍服从项目超时及取消信号。画布沿用同步结果回执，重启后补下载不再 POST；网络不确定与确定的 4xx 拒绝保持区分。下载地址不附带方舟 Key。

## 官方依据（2026-10-07 核对）

- [图片生成教程与模型 ID](https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh)
- [图片生成 API：参考图、尺寸、参数与返回值](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)

## 验证与生效

本次未发送真实生成请求，未验证账户模型开通状态或真实出图质量。协议、参考图排序与上限、非法尺寸拒绝、Key 不进入结果下载、画布模型注册及回执恢复由本地测试覆盖。

源码桌面实例仍运行更新前的 standalone。通过 `start-desktop.command` 重新启动时，构建戳会检测源码变化并重新构建；本次不停止当前桌面实例，不更新安装包。


验证结果：

- `ark-images.test.ts`、`company-provider-seed.test.ts`、`creative-canvas-providers.test.ts`、`creative-canvas-external-recovery.test.ts`、`company-gateway-size.test.ts`、`image-generation-contract.test.ts` 通过。
- TypeScript 通过；相关文件 ESLint 0 errors、2 个原有 queue warnings；补丁格式检查通过。
- 临时源代码副本的 Next webpack 生产编译、类型与静态页面生成通过。隔离目录软链接依赖导致默认 Turbopack 构建及 standalone 资源同步失败；未覆盖当前运行目录的构建产物，不把此项报告为完整打包通过。
- 使用隔离数据根及假 Key 启动本机预览，浏览器确认设置页新增供应商；`/api/canvas/models` 返回该模型、两种生成模式、1K／2K 和参考图上限 10，响应不含假 Key。未在真实账户调用模型。
