# macOS 安装包

Creative Studio 的 macOS 安装包是 Apple Silicon 专用的未签名 DMG。安装后应用显示为 `产品素材工作台.app`，内置私有 Node.js 运行时，用户不需要单独安装 Node/npm，也不需要 Rosetta。

## 前置条件

- macOS 11 或更高版本，Apple Silicon。
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
3. 双击应用，默认浏览器会打开 `http://127.0.0.1:3000`。

## 首次启动

当前 DMG 是未 notarize 的本机安装包。首次启动可能被 Gatekeeper 拦截，可任选一种方式：

```bash
xattr -dr com.apple.quarantine "/Applications/产品素材工作台.app"
```

或在 Finder 中右键 `产品素材工作台.app`，选择“打开”，确认一次。

## 停止服务

优先使用应用自带的优雅关闭接口：

```bash
curl -X POST http://127.0.0.1:3000/api/shutdown
```

如果服务没有响应，可以按 PID 文件停止：

```bash
kill "$(cat ~/Library/Application\ Support/CreativeStudio/storage/run/server.pid)"
```

## 数据位置

macOS 安装版不会把数据库、上传文件、日志写进 `.app` 包内。所有运行数据都在：

```text
~/Library/Application Support/CreativeStudio
```

常见内容：

```text
data/workbench.db
storage/logs/
storage/run/server.pid
storage/final-videos/  (成片包装产物)
storage/bgm/           (BGM 库)
```

## 卸载

1. 把 `/Applications/产品素材工作台.app` 移到废纸篓。
2. 如需同时删除本地数据：

```bash
rm -rf ~/Library/Application\ Support/CreativeStudio
```
