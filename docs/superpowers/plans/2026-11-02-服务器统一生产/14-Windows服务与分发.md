# 14 Windows服务与分发

**状态：** `needs-triage`  
**依赖：** [00 主机与额度核验](00-主机与额度核验.md)、[01 运行模式与共享迁移](01-运行模式与共享迁移.md)、[02 账号会话与管理入口](02-账号会话与管理入口.md)、[07 旧图片视频队列接入](07-旧图片视频队列接入.md)、[08 普通脚本与LLM持久执行](08-普通脚本与LLM持久执行.md)、[09 批量详情脚本与媒体资源](09-批量详情脚本与媒体资源.md)、[10 创作画布接入](10-创作画布接入.md)、[12 轻客户端与可信更新](12-轻客户端与可信更新.md)  
**目标：** 生成可复验的服务端包和轻客户端包，部署受控内网HTTPS及无人登录常驻服务。

## 动手前

阅读 [技术方案](../../specs/2026-11-02-服务器统一生产-技术方案.md) 中对应章节与仓库 AGENTS.md；改动具体模块前读取其 docs/reference 文档。先核实依赖任务的完成证据，再将状态调整为可实施。本任务单描述待做工作，不代表功能已存在。

## 改动范围

修改 `scripts/build-production.mjs`、`scripts/sync-standalone-assets.mjs`、`scripts/packaging/forbidden-paths.json`；拟新增两类构建脚本、`scripts/team-server/` SCM/WinSW/Caddy配置生成与安装/停止/状态入口。

## 实施步骤

1. 锁定正式WinSW/Caddy、Node/Python和媒体依赖版本、哈希与运行前提；server入口加入明确白名单，PS1 BOM与JSON编码遵守现有约定。
2. 安装独立SCM服务与服务账号：入口、应用、可选LiteLLM；固定回环端口与origin，受控stop helper调用gracefulShutdown并核验退出。
3. server模式禁用旧detached sidecar-stop；LiteLLM降级不阻塞外部供应商，整套停机由运维脚本按依赖执行。
4. 证书分发与防火墙仅放行获准内网；旧服务、旧根、未知PID不被认领或结束；新旧配置/stack状态隔离。
5. 两类包各自白名单、敏感内容扫描、原生模块真实加载和媒体工具探针；发布到新release目录。

## 完成标准

- 开机无人登录、RDP断开与账号注销后业务仍可用；SCM停止/异常重启无重复执行和本实例进程残留。
- 员工设备信任HTTPS，app/LiteLLM回环端口不可从员工网段直连；本机运维路由不被代理转发。
- 服务端运行不依赖开发源码或个人用户目录；轻客户端不含生产库/Next后台/FFmpeg/Python/Key；原包守护断言保留。

## 验证

复用 `standalone-desktop-boundary.test.mjs`、`windows-portable-{payload,publish}.test.mjs`、`python-runtime-windows.test.mjs`、company-provider与runtime进程树测试；Windows服务账号真实FFmpeg/GPU/CPU回退按部署手册验证。

新增行为测试使用临时数据根并在动态导入前设置环境；具体运行方式以已有测试文件头为准。完成时记录修改文件、测试命令/结果、剩余阻断和依赖变化，不把未执行的检查写成通过。

