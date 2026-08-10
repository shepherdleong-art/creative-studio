# macOS 安装包

Creative Studio 的 macOS 安装包是 Apple Silicon 专用的 Electron DMG。安装后应用显示为 `产品素材工作台.app`，内置私有 Node.js 运行时，用户不需要单独安装 Node/npm，也不需要 Rosetta。

## 前置条件

- macOS 12 或更高版本，Apple Silicon（Electron 运行时最低版本）。
- 构建机使用 Node 22.x。打包内置运行时是 Node 22.22.3，构建机 Node 主版本必须一致，避免 `better-sqlite3` 或 `sharp` 原生模块 ABI 不匹配。
- Xcode Command Line Tools，提供 `clang`、`iconutil`、`codesign`、`hdiutil` 和 `sips`。

安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

## 构建

```bash
npm run build:mac-installer
```

正式分发必须提供 Developer ID 签名身份和已保存的 `notarytool` keychain profile：

```bash
CREATIVE_STUDIO_MAC_SIGNING_IDENTITY="Developer ID Application: <团队> (<TeamID>)" \
CREATIVE_STUDIO_MAC_NOTARY_PROFILE="<notarytool-profile>" \
npm run build:mac-installer
```

仅用于本机验证载荷时，可显式允许未公证构建（不能用于外发）：

```bash
bash scripts/build-mac-installer.sh --skip-npm-ci --allow-adhoc
```

输出文件：

```text
dist/macos/产品素材工作台-<version>.dmg
```

如果已经确认依赖是当前 Mac 上用 Node 22.x 安装的，可以跳过 `npm ci`：

```bash
bash scripts/build-mac-installer.sh --skip-npm-ci
```

## 安装

1. 打开 `dist/macos/产品素材工作台-<version>.dmg`。
2. 把 `产品素材工作台.app` 拖到 Applications。
3. 双击应用，Electron 窗口会连接本机 loopback 上的随机服务端口；服务不会监听公网地址。

## 首次启动（仅本机未公证包）

未公证的本机验证包首次启动可能被 Gatekeeper 拦截，可任选一种方式：

```bash
xattr -dr com.apple.quarantine "/Applications/产品素材工作台.app"
```

或在 Finder 中右键 `产品素材工作台.app`，选择“打开”，确认一次。

## 从源码启动桌面版（不装 DMG）

开发或需要公司供应商时，可以直接从仓库运行桌面壳，双击：

```text
start-desktop.command
```

脚本会依次确认 Node、依赖和 Electron 运行时，检测 3000 端口冲突，拉起可选的 LiteLLM sidecar，确保 `.next/standalone` 产物存在（缺失时自动 `npm run build`），编译桌面壳后启动 Electron。

代码更新后需要显式重建 standalone 产物：

```bash
./start-desktop.command --rebuild
```

与安装版的关键差异：

- 数据根是**项目目录**（`data/`、`storage/`），不是 `~/Library/Application Support/CreativeStudio`；与网页版共用同一个 `data/workbench.db`，不要和 `start.command` 同时运行。
- 依赖本机 Node 和 `node_modules`，不使用打包的私有运行时。
- 支持公司供应商（见下）。

## 停止服务

Electron 窗口关闭只会隐藏窗口，任务仍在后台运行。请从应用菜单选择“退出 Creative Studio”以触发服务优雅关闭和进程树回收；如果应用已经失去响应，可在“活动监视器”中强制退出应用，下次启动时持久化租约会负责恢复任务状态。

## 数据位置

macOS 安装版不会把数据库、上传文件、日志写进 `.app` 包内。所有运行数据都在：

```text
~/Library/Application Support/CreativeStudio
```

常见内容：

```text
data/workbench.db
storage/logs/
storage/run/electron-service.json  # 当前 loopback origin/instance，退出时清理
```

## 已知行为差异

- **安装版不支持公司供应商网关。** 安装包载荷有意剪除了 `config.yaml` 和 `.venv-litellm/`（连同 `data/`、`storage/`、`.env*` 等本地数据与凭据），因此 `.app` 不会拉起 LiteLLM 代理，`/settings` 里执行范围为「公司」的供应商不可用。需要公司模型时，请用源码态 `start-desktop.command`。
- Electron 窗口内点击 `ResultGallery` 的参考图会直接下载文件，不会像浏览器标签页那样打开新标签；这是桌面壳的安全下载策略。
- 首次登记链接原片会完整读取文件做内容校验；大素材需要等待，过程中不会复制原文件。

## 卸载

1. 把 `/Applications/产品素材工作台.app` 移到废纸篓。
2. 如需同时删除本地数据：

```bash
rm -rf ~/Library/Application\ Support/CreativeStudio
```
