# macOS 桌面版（源码运行）

在 macOS 上从仓库源码运行 Electron 桌面壳。只用网页版时双击 `start.command` 即可，不需要桌面壳。

## 启动

从仓库运行桌面壳，双击：

```text
start-desktop.command
```

脚本会依次确认 Node、依赖和 Electron 运行时，检测 3000 端口冲突，拉起可选的 LiteLLM sidecar，确保 `.next/standalone` 产物存在（缺失时自动 `npm run build`），编译桌面壳后启动 Electron。

代码更新后需要显式重建 standalone 产物：

```bash
./start-desktop.command --rebuild
```

注意：

- 数据根是**项目目录**（`data/`、`storage/`），不是 `~/Library/Application Support/CreativeStudio`；与网页版共用同一个 `data/workbench.db`，不要和 `start.command` 同时运行。
- 依赖本机 Node 和 `node_modules`，不使用打包的私有运行时。
- 支持公司供应商。

## 停止服务

以下任一方式都会触发服务优雅关闭和进程树回收，并停止受控的 LiteLLM 代理。需要继续后台任务时请最小化窗口。

- 应用菜单选择“退出 Creative Studio”。
- 点击桌面窗口的关闭按钮：显示与电源按钮相同的“停止服务并退出”弹窗，确认后停止服务，取消后继续运行。
- 界面右上角的电源按钮“停止服务并退出”：服务停止后应用会自动退出，不会留下指向已关闭端口的空窗口。
- 从源码运行时，关闭启动窗口或按 `Ctrl+C`。
- 双击仓库根目录的 `stop-desktop.command`。

`stop-desktop.command` 用于应用失去响应，或从 Finder 启动后没有终端窗口可用的情况。它会依次检查 `CREATIVE_STUDIO_DATA_ROOT`、项目目录和 `~/Library/Application Support/CreativeStudio` 三个受控数据根，用 `/api/desktop/health` 校验 `instanceId` 与状态文件一致后才请求 `/api/shutdown`，最后才按可执行文件绝对路径做有界兜底回收——不会按端口或进程名误杀其他进程。

如果应用已经完全失去响应，也可在“活动监视器”中强制退出，下次启动时持久化租约会负责恢复任务状态。

## 数据位置

源码桌面版的数据根是项目目录，与网页版共用同一份数据；设置 `CREATIVE_STUDIO_DATA_ROOT` 可以改到别处。常见内容：

```text
data/workbench.db
storage/logs/
storage/run/electron-service.json  # 当前 loopback origin/instance，退出时清理
```

## 已知行为差异

- Electron 窗口内点击 `ResultGallery` 的参考图会直接下载文件，不会像浏览器标签页那样打开新标签；这是桌面壳的安全下载策略。
- 首次登记链接原片会完整读取文件做内容校验；大素材需要等待，过程中不会复制原文件。

## 以前装过 DMG 的机器

DMG 安装包已于 2026-10-25 停止提供。以前装过的机器可以这样清理（旧数据在 `~/Library/Application Support/CreativeStudio`）：

1. 把 `/Applications/产品素材工作台.app` 移到废纸篓。
2. 如需同时删除本地数据：

```bash
rm -rf ~/Library/Application\ Support/CreativeStudio
```
