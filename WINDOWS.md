# Windows 使用说明

## 1. 安装要求

- Windows 10/11
- Node.js 20 或更高版本，推荐 LTS: https://nodejs.org
- 首次安装依赖需要联网

本项目已在以下环境验证：

```text
Node.js v22.22.3
npm 10.9.8
Windows 本地路径 I:\batch-image-workbench-main
```

## 2. 推荐启动方式

双击：

```text
start-windows.cmd
```

启动器会做这些事：

- 检查 Node.js 和 npm
- 检查 `node_modules`
- 如果没有依赖或依赖不是 Windows 原生包，则运行 `npm ci`
- 启动 Next.js 本地服务
- 自动打开浏览器

默认地址：

```text
http://127.0.0.1:3000
```

## 3. 换端口

如果 3000 被占用，在 PowerShell 里运行：

```powershell
$env:BATCH_WORKBENCH_PORT=3001
.\start-windows.cmd
```

然后访问：

```text
http://127.0.0.1:3001
```

## 4. 停止服务

方式 A：在启动窗口按 `Ctrl+C`

方式 B：双击：

```text
stop-windows.cmd
```

## 5. 手动命令

如果不使用双击脚本：

```powershell
Set-Location I:\batch-image-workbench-main
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3000
```

## 6. 迁移和打包注意事项

不要把这些目录或文件当作源码迁移：

```text
node_modules/
.next/
data/
storage/
.env.local
```

原因：

- `node_modules` 里有 `sharp` 和 `better-sqlite3` 的系统原生二进制，Mac 和 Windows 不能混用。
- `.next` 是构建缓存。
- `data/workbench.db` 是本机数据库，可能包含供应商配置和 API Key。
- `storage` 是本机上传图、输出图和日志。
- `.env.local` 可能包含密钥。

干净迁移方式：

1. 从 GitHub 下载源码。
2. 在 Windows 上运行 `start-windows.cmd`。
3. 在 `/settings` 页面重新配置供应商 API Key。

## 7. Packy 使用提醒

Packy 是长连接同步返回，没有 task_id 和轮询。建议首次付费测试：

- 输入图 1 张
- 参考图 0 张
- Quality 选 `low` 或 `medium`
- Concurrency 设为 `1`
- Max attempts 设为 `1`

确认单图成功后，再测试参考图。
