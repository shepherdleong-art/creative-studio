# 14 Windows服务与分发

**状态：** `needs-info`
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

## Comments

### 2026-11-02 本地实现与隔离证据

- 构建与边界：`sync-standalone-assets.mjs` 显式携带 `runtime/team-server-entry.cjs`；新增 `build:team-server`，独立装配 app、精简 Node、Caddy、WinSW、可选 Python、运维脚本和逐文件 SHA-256 manifest，不复制完整 npm 工具链。轻客户端继续独立装配，并与 server 共用精确顶层白名单、链接/数据库/环境文件/私钥和候选敏感值扫描；旧 portable/core 禁入断言未删。`distribution-lock.json` 锁 WinSW 2.12.0（正式版）、Caddy 2.10.2、Node 22.22.3/ABI 127、Python 3.12.10＋LiteLLM 1.89.2 及 FFmpeg/FFprobe/SQLite/sharp 的正式来源与已核对 SHA-256，未填未知哈希。
- 服务与运维：新增 Caddyfile、环境文件和 Caddy/app/可选 LiteLLM 三份 WinSW 定义，固定回环、gMSA/受限内置账号、日志轮换、失败退避和 240 秒应用停止预算。`preflight/install/status/stop` 默认 dry-run；只有显式 `-Apply` 才允许 SCM/ACL/防火墙变更，证书信任不由脚本伪造或下发。新旧根重叠、目录链接、普通口令账号、未知 SCM PathName、非本 release PID/新子进程均 fail closed。独立 LiteLLM 不是 app 依赖，app 不调用旧 detached sidecar 停止。
- 停机闭环：新增仅回环可达且由 Caddy 阻断的 `/api/team/operations/{status,shutdown}`，ACL 控制凭据只从文件读取，不进入命令行、日志或包；shutdown 绑定 instance 并复用唯一 `gracefulShutdown`。helper 复核部署、instance、release 进程树和有界退出，超时只允许处置复核后的已记录树。release 同时携带独立 `init-admin` / `recover-admin` CLI 及其运行依赖闭包，不需要开发源码目录。
- 自动测试均通过：`team-server-{distribution-lock,config,scripts,service-control,operations,package-boundary,native-probe}`、`standalone-desktop-boundary`、`team-client-package-boundary`、`team-api-coverage`（235 routes / 295 methods）、`team-server-preflight`、`windows-portable-{payload,publish}`、`python-runtime-windows`、`company-provider-{startup,runtime,seed}`、`runtime-process-tree`，以及 00/01/12 点名的运行隔离、迁移、健康、优雅停机、远程客户端、可信更新和 Electron 回归。`npx tsc --noEmit --pretty false` 与 ticket14 定向 ESLint 通过。
- 真实本地构建：`npm run setup:packaging` 与 `npm run build` 成功（仅既有 NFT warnings）；按受控锁生成无 LiteLLM 的正式模式 server release，13,639 个 manifest 登记文件通过哈希/敏感边界复核，Node ABI、SQLite、sharp/libvips、Caddy 版本、管理 CLI 模块加载和 FFmpeg→FFprobe 的 FFV1 CPU 往返探针通过。另一临时数据根完成 release 的 status→gracefulShutdown→进程树退出冒烟；管理员初始化/恢复 CLI 也在临时数据根通过，输出的一次性凭据未记录。Caddyfile 经正式 Caddy 2.10.2 `fmt` 验证，生成的 SCM XML 经 .NET 解析。轻客户端以临时密钥和 Electron fixture 通过独立包/签名边界测试；未宣称正式签名发布。
- 未解除的现场阻断：尚未取得目标 Windows Server、实际 gMSA/服务账号及 ACL、真实 SCM 安装/异常重启、无人登录/RDP 断开/注销证据；未配置或信任真实内网证书，未核验员工网段 HTTPS 与防火墙；本地 server 冒烟显式 `--without-litellm`，未完成实际 Python/LiteLLM SCM 降级验证；未在服务账号下验证随包 FFmpeg、NVENC/CPU 回退，未做真实两设备客户端/正式签名更新。上述均不得由 fixture 或本机冒烟替代，因此状态保持 `needs-info`。

