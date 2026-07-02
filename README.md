# Creative Studio

Creative Studio 是一个本地优先的 AI 素材生产工作台，用来把复杂结构产品从「一张素材图」推进到「场景图、分镜图、脚本、视频任务和导出包」。

它基于 Next.js 构建，适合在 Windows 和 macOS 本地运行。API Key、项目数据、生成结果默认保存在本机，不需要把素材和密钥交给外部后台托管。

## 主要能力

- **复杂产品素材流**：创建产品项目，维护产品名、编号、品类、供应商、模型、画面比例、清晰度和图片预处理参数。
- **场景图生成**：上传原始素材，按项目提示词生成候选场景图。
- **场景参考图**：将满意的场景图设为参考图（支持命名），后续生成可引用参考图保持风格一致。缩略图显示参考图名称标记。
- **分镜管理**：把场景图整理成分镜组，为后续视频任务和脚本生成提供稳定素材结构。
- **分镜重做增强**：重做分镜时支持切换底图（原图/当前结果）、选择参考图组合、更换生成供应商，灵活调整再生成策略。
- **分镜结果候选切换**：保留分镜每次生成的历史结果，支持在预览界面左右切换、缩略图选取，选中结果同步到分镜当前图并影响 redo 参数。
- **脚本生成**：围绕卖点、人群、平台、语气和分镜组生成口播脚本，并支持图文审阅和复制。
- **视频任务准备**：基于分镜创建视频任务，支持视频供应商配置、任务轮询、重试和结果预览。
- **供应商切换与故障转移**：重新生成时可选择不同供应商，支持进度中的故障切换控制。供应商预设有 GPT.ge 等内置选项。
- **批量编辑兼容模式**：保留旧版批量图片编辑流程，可上传参考图和待处理图后并发生成结果。
- **图片输出尺寸规整**：生成结果自动检测与目标尺寸是否一致，不一致时通过 sharp 居中裁切至目标尺寸并记录日志。
- **本地导出**：支持下载项目产物、创意包、脚本和生成素材，便于交付或二次编辑。下载 zip 包含分镜的全部历史候选结果。

## 技术栈

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- SQLite via `better-sqlite3`
- `sharp` 图片预处理
- `archiver` ZIP 导出

## Windows 快速启动

推荐直接双击：

```text
start-windows.cmd
```

启动脚本会检查 Node.js、安装依赖、启动本地服务，并尝试打开浏览器。

默认访问地址：

```text
http://127.0.0.1:3000
```

停止服务：

```text
stop-windows.cmd
```

详细说明见 [WINDOWS.md](./WINDOWS.md)。

## macOS 快速启动

推荐直接双击：

```text
start.command
```

如果 macOS 提示没有执行权限，可以在终端运行一次：

```bash
chmod +x start.command stop.command start.sh stop.sh
```

然后再次双击 `start.command`，或在终端运行：

```bash
./start.command
```

默认访问地址：

```text
http://localhost:3000
```

停止服务：

```text
stop.command
```

也可以在启动窗口按 `Ctrl+C` 停止。

## 手动启动

需要 Node.js 20 或更高版本。

```bash
npm ci
npm run dev
```

然后打开：

```text
http://localhost:3000
```

Windows 如果需要固定本机地址，可运行：

```powershell
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Windows 快启脚本换端口：

```powershell
$env:BATCH_WORKBENCH_PORT=3001
.\start-windows.cmd
```

## 首次使用

1. 打开 `/settings`。
2. 添加图片供应商，例如 Packy、GeekAI 或其他 OpenAI-compatible 图片接口。
3. 填写 Base URL、API Key、模型名和默认单图成本。
4. 只启用当前要测试的供应商，避免误用其他余额。
5. 返回首页，新建复杂结构产品项目或旧版批量编辑项目。

API Key 会存储在本地 SQLite 数据库中，前端列表只显示是否已配置，不显示明文 Key。


## 常用命令

```powershell
npm run dev
npm run lint
npm run build
npm run start
```

## Windows 安装包

提供 Inno Setup 编译的一键安装程序，内置私有 Node.js 运行时，用户无需安装 Node/npm。

```powershell
npm run build:win-installer
```

安装包输出到 `dist/windows/CreativeStudioSetup.exe`。安装后可从桌面或开始菜单启动，默认卸载保留本地数据。

## 目录结构

```text
app/                    Next.js 页面和 API 路由
components/             工作台 UI 组件
components/ui/          通用 UI 原语和图标
installer/windows/      Windows 安装包脚本和配置
lib/                    数据库、队列、供应商适配器、文件导出等核心逻辑
lib/providers/          图片生成供应商适配器
lib/script-providers/   脚本生成供应商适配器
lib/video-providers/    视频生成供应商适配器
docs/                   设计、评审和实现记录
outputs/                阶段性规格、测试清单和交付记录
scripts/                启停辅助脚本、数据库迁移测试套件
```

## 本地数据和安全

这些目录或文件属于本机运行数据，不应提交或打包给别人：

```text
node_modules/
.next/
data/
storage/
.env.local
```

原因：

- `node_modules` 包含 Windows/Mac/Linux 不同的原生二进制依赖。
- `.next` 是 Next.js 构建缓存。
- `data/` 通常包含本地 SQLite 数据库，可能保存供应商配置。
- `storage/` 通常包含上传素材、生成图片、视频和日志。
- `.env.local` 可能包含 API Key。

干净迁移方式：从 GitHub 下载源码，在目标机器运行 `npm ci`、`start-windows.cmd` 或 `start.command`，再到 `/settings` 重新配置供应商。

## 适用场景

- 电商产品场景图批量生产
- 家居、消费品、复杂结构产品的分镜素材管理
- 短视频脚本和分镜图文对照
- 多供应商 API 测试和成本控制
- 本地私有素材工作流

## 状态

当前项目仍在快速迭代中，重点方向是复杂结构产品的图片生产、分镜管理、脚本生成和视频任务准备。旧版批量图片编辑流程仍保留，作为兼容模式使用。

## 许可证

Copyright (C) 2026 liangpeijian

本项目以 [GNU General Public License v3.0 only](./LICENSE) 授权。你可以使用、修改和分发本项目；如果向他人分发本项目或其修改版本，需要遵守 GPL-3.0 的条款并提供相应源码。

本项目调用的第三方服务、生成模型及其输出可能适用各自独立的服务条款或许可证，不因本项目采用 GPL-3.0 而自动改变。
