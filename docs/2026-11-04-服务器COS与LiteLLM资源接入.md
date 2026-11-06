# 服务器 COS 与 LiteLLM 资源接入

## 授权与范围

用户要求使用本地 COS 和 LiteLLM 模型资源配置公司服务器，明确并发为：七牛模型 100、其他图片和视频 50、脚本 20；同时要求管理员可以在前端修改。

## 已应用配置

- 目标：AI-TEST-PC（10.20.16.165），沿用 `team-server-release-ui-a-20261104`。没有修改不可变 release 负载或 manifest。
- 本地 `config.yaml` 复制到 `D:\CreativeStudio\data\config.yaml`；只迁移本地 `.env.local` 的 COS 配置，另设置画布 company 执行器，不复制其他供应商密钥。文件 ACL 限 SYSTEM/管理员完全控制、LocalService 读取。
- 应用 XML 显式加载数据根 `.env.local`，再加载托管 `app.env`；部署身份与受信 origin 由后者覆盖。未把密钥写入托管环境文件、源码、日志或聊天。
- 新建自动启动的 `CreativeStudioLiteLLM` SCM 服务，绑定 `127.0.0.1:4300`；应用仍绑定 `127.0.0.1:3300`，仅 Caddy 提供 HTTPS 入口。模型连接地址同步到服务器代理端口。
- `service/litellm-service.py` 每次启动写 `storage/run/stack.json`，记录自身真实 PID/端口；退出时只清理自己拥有的状态。清除代理环境变量，禁写 Python 字节码，避免改动 release 清单。
- 通过既有受控池服务写入 `company:qiniuyun=100`、`company:other-media=50`、`llm:remote=20`，没有给每个模型重复分配整组额度。图片、视频和画布复用媒体池。
- 本机 LiteLLM 不校验调用方 Bearer。为区分两个管理员确认的模型额度组，工作台使用两个不同的非秘密本机调用标识；真正上游 Key 只保留在 YAML，由 LiteLLM 按模型路由。此划分不是上游额度隔离的实测证明，也不能约束其他本地工作台的提交。
- 两个旧视频预设按本地现有设置接入相应代理模型；不删除历史行或迁移项目。

## 管理端修改

`/team/admin/pools` 已提供容量输入与“保存该池”，通过 `/api/team/pools` 管理员授权、CSRF 和版本校验保存。共享同一池的其他模型刷新后显示相同容量。下调不会撤销已占用名额或中断现有结果收取；新任务按新容量准入。

## 验收结果

2026-11-04 16:38（UTC+8）完成重启验收：App/Caddy/LiteLLM 全部 Running、Automatic，应用 ready=true，两个业务端口均仅回环监听。公司运行环境为 ready，cosConfigured=true；图片、视频、脚本和画布的池要求均 ready。

- LiteLLM 加载本地 25 个别名；两组上游密钥的只读 `/models` 查询均返回 200。24 个别名出现在上游清单；`GPT-5-5` 不在清单中，未将其设为默认脚本模型或宣称可用，正式脚本仍用 `GPT-5-6-Luna-Standard`。
- COS 使用 68 字节测试 PNG 验证上传及签名读取，返回 200，字节一致；未输出签名 URL。
- 没有提交付费图片、视频或脚本生成任务，因此不把连通性验证等同于所有模型的生成验收。
- `team-server-config.test.mjs` 9 项通过，包含生成服务的真实 PID、两次启动及状态清理测试；`team-pool-config.test.ts` 通过。
- 前置一致性备份 `E:\CreativeStudio\backup\manual\resources-20261104-before` 成功；原部署与服务配置副本在 `deployment/config/before-resources-20261104`。
- 证据：`outputs/resource-config-20261104/runtime-verified.json`、`models-applied.json`、`models-preview.json`。所有文件不含密钥。

## 未配置与后续升级边界

TTS/配音不属于这次指定的 COS/LiteLLM 资源，其独立凭据与 `tts:remote` 池仍未配置。管理页可能仍显示这一项未就绪；不影响已配置的图片、视频、脚本和画布调用门禁。

本轮更新了工作区 `scripts/team-server/generate-config.mjs` 及服务器受控 service 目录中的生成器，未重打 Next release。下一次软件升级须包含新版生成器；现有 release 自带的旧维护 runner 会调用其旧生成器，切换时可能覆盖资源环境加载与 LiteLLM 入口。因此下一次升级需用新版生成器重生成 service 配置并重启验证，不能直接沿用旧生成结果。部署 JSON 已同步当前 releaseId 和 enableLiteLLM=true。
