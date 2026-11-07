# Mac 本地团队桌面启动器

这个目录启动**本机团队服务器 + Electron 团队客户端**。它连接本机 `127.0.0.1`，不需要内网、Windows 服务器或公网地址。

## 启动

双击 `start.command`，或在仓库根目录运行：

```bash
bash team-desktop/start.command
```

首次运行会初始化工号 `0001` 的本机管理员。终端会显示一次性凭据；登录后立即修改密码。客户端关闭后，启动器会停止本次团队服务器。

需要强制重建时：

```bash
bash team-desktop/start.command --rebuild
```

## 停止

优先使用客户端退出入口，或在启动终端按 `Ctrl+C`。终端不可用且应用失去响应时运行：

```bash
bash team-desktop/stop.command
```

停止入口会核对部署与进程身份，并通过团队服务的正式停机接口排空任务。它不会按端口或进程名结束其他程序。

## 管理员凭据恢复

先停止本地团队工作台，再运行：

```bash
bash team-desktop/recover-admin.command --employee-id 0001
```

## 数据与配置

- 数据根是 `team-desktop/data-root/`，已被 `.gitignore` 排除。
- 这个目录与仓库根目录的本地个人工作台数据隔离，不能同时共用同一份数据库。
- 默认端口是 `3400`，服务只监听 `127.0.0.1`。
- 如数据根没有 `.env.local`，启动器会读取仓库根目录的 `.env.local`；不要复制或提交密钥。
- 公司网关所需的 `config.yaml` 与 `.venv-litellm` 仍沿用仓库根目录。LiteLLM 失败只禁用公司供应商，不阻塞启动。

可用环境变量：

- `CREATIVE_STUDIO_TEAM_LOCAL_PORT`：默认 `3400`。
- `CREATIVE_STUDIO_TEAM_LOCAL_DATA_ROOT`：替换默认数据根。
- `CREATIVE_STUDIO_TEAM_LOCAL_DEPLOYMENT_ID`：默认 `mac-local-team`。

这是源码运行入口，不是 DMG 安装包。修改 `app/`、`components/` 或 `lib/` 后，下次启动会根据构建戳自动重建。
