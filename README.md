# Creative Studio

Creative Studio 是一个本地优先的 AI 素材生产工作台，把产品素材图推进到「场景图 → 分镜图 → 口播脚本 → 视频任务 → 智能混剪成片 → ZIP 导出包」的完整流水线；在“智能混剪”入口下，既可单条精调并导出，也可按批次批量产出多条成片。

它基于 Next.js 构建，适合在 Windows 和 macOS 本地运行。API Key、项目数据、生成结果默认保存在本机；需要公网交付给上游模型的参考图走腾讯云 COS 中转（可配置）。

## 主要能力

- **复杂产品素材流**：创建产品项目，维护产品名、编号、品类、供应商、模型、画面比例、清晰度和图片预处理参数。
- **场景图生成**：上传原始素材，按项目提示词生成候选场景图。
- **场景参考图**：将满意的场景图设为参考图（支持命名），后续生成可引用参考图保持风格一致。缩略图显示参考图名称标记。
- **分镜管理**：把场景图整理成分镜组，为后续视频任务和脚本生成提供稳定素材结构。
- **分镜重做增强**：重做分镜时支持切换底图（原图/当前结果）、选择参考图组合、更换生成供应商，灵活调整再生成策略。
- **分镜结果候选切换**：保留分镜每次生成的历史结果，支持在预览界面左右切换、缩略图选取，选中结果同步到分镜当前图并影响 redo 参数。
- **脚本生成**：围绕卖点、人群、平台、语气和分镜组生成口播脚本，并支持图文审阅和复制。
- **视频任务准备**：基于分镜创建视频任务，支持视频供应商配置、任务轮询、重试和结果预览。
- **智能混剪成片**：分析视频素材（本地抽帧 + 视觉模型）、TTS 生成配音与字幕对齐、组时间线、ffmpeg 渲染最终成片。
- **批量生产**：与单条智能混剪共用同一个“智能混剪”入口，提供“单条精调”和“批量成片”两种模式；单条模式用于逐条调整并导出，批量模式用于按批次组织素材和脚本、一次产出多条成片。
- **公司网关接入**：可选联动本地 LiteLLM 代理（127.0.0.1:4000）接入公司模型网关，可灵、Seedance、image2、nano-banana 等模型走统一任务协议。
- **腾讯云 COS 参考图中转**：参考图按内容哈希上传 COS 并生成 24h 预签名 URL 传给网关上游。
- **供应商切换与故障转移**：重新生成时可选择不同供应商，支持进度中的故障切换控制。供应商预设有 GPT.ge 等内置选项。
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
- `ffmpeg-static` / `ffprobe-static` 成片渲染与媒体探测

## 全新机器安装（AI 代理可按序执行）

前提：Node.js 20 或更高版本（打包安装形态不需要，见下文安装包小节）。

```bash
git clone <repo-url>     # 或下载源码解压
cd creative-studio
npm ci                   # 安装依赖（含 better-sqlite3 / sharp 原生模块）
npm run dev              # 开发模式启动
```

启动后访问：

```text
http://localhost:3000
```

安装自检（都不需要真实密钥）：

```bash
node scripts/db-migrations.test.ts   # 数据库迁移
node scripts/cos-media.test.ts       # COS 模块单元测试（mock）
node scripts/local-image-url.test.ts # 本地图片 URL 解析
npm run lint
```

Windows 如需固定本机地址或换端口：

```powershell
npm run dev -- --hostname 127.0.0.1 --port 3000
$env:BATCH_WORKBENCH_PORT=3001; .\start-windows.cmd
```

## 参考图公网交付：腾讯云 COS（公司网关场景必填）

上游模型（腾讯等）只接受可公网访问的图片 URL。配置 COS 后，任务提交时参考图会按内容 SHA-256 命名上传（重复图自动跳过），并生成 24h 预签名 URL 传给网关。

在仓库根目录新建 `.env.local`（已被 `.gitignore` 排除，绝不提交）：

```dotenv
CREATIVE_STUDIO_COS_SECRET_ID=<腾讯云 COS 子账号 SecretId>
CREATIVE_STUDIO_COS_SECRET_KEY=<腾讯云 COS 子账号 SecretKey>
CREATIVE_STUDIO_COS_DOMAIN=<COS 域名，不带协议，如 chanzhong-1314313902.linshimuye.com>
CREATIVE_STUDIO_COS_SIGN_HOST=<CDN 回源改写 Host 时填源站端点，如 chanzhong-1314313902.cos.ap-guangzhou.myqcloud.com；否则与 DOMAIN 相同即可>
CREATIVE_STUDIO_COS_PREFIX=ref-images/
CREATIVE_STUDIO_COS_URL_TTL_SEC=86400
```

说明：

- `SIGN_HOST` 的判据：用 CDN 自定义域名且回源 Host 被改写为源站端点时必填；直连 `*.myqcloud.com` 默认端点时不需要。
- 不配 COS 时的回退行为：图片任务回退本机 HTTP URL 或 data URL；视频任务找不到可公网访问的首帧地址会报错并提示配置。
- 真机验证（配好密钥后）：`COS_LIVE_TEST=1 node scripts/cos-media.test.ts`，做一次真实上传 + 下载比对。
- 建议给 bucket 配生命周期规则（如 7 天自动删除），存储量不随时间累积。

## 公司网关联动（可选，macOS / Windows 源码运行）

适用：模型走公司统一网关（`llm-gateway-idc.linshimuye.com`），经本地 LiteLLM 代理转发。

1. 安装 Python 3.10–3.13（推荐 3.12），在仓库根目录准备 `.venv-litellm`：

   macOS：

   ```bash
   python3.12 -m venv .venv-litellm
   .venv-litellm/bin/python -m pip install -r requirements-litellm.txt
   ```

   Windows PowerShell：

   ```powershell
   py -3.12 -m venv .venv-litellm
   .\.venv-litellm\Scripts\python.exe -m pip install -r requirements-litellm.txt
   ```

2. 仓库根目录放置 `config.yaml`（LiteLLM 配置，含网关 Key——**绝不提交**，`.gitignore` 已排除）。
3. macOS 双击 `start.command`（网页版）或 `start-desktop.command`（桌面版），Windows 双击 `start-windows.cmd`：检测到虚拟环境与配置后，会先把 LiteLLM 强制绑定到 `http://127.0.0.1:4000`，再启动工作台；对应停止脚本、启动窗口 Ctrl+C、桌面版退出、UI 关闭按钮都会把代理一并关闭。注意 macOS 安装版（DMG）的载荷不含 `config.yaml` 与 `.venv-litellm`，因此**安装版不支持公司供应商**。
4. 在 `/settings` 添加供应商：Base URL 填 `http://127.0.0.1:4000`，执行范围选“公司”；图片选 `gateway-task-image` 类型，视频选 `openai-video` 类型。

注意：两个平台的启动命令都显式传入 `--host 127.0.0.1`；请勿改成 `0.0.0.0` 或将本服务暴露到公网。`scripts/*.ps1` 必须保持 UTF-8 带 BOM，否则 PS 5.1 解析中文会失败。

## Windows 快速启动

推荐直接双击：

```text
start-windows.cmd
```

启动脚本会检查 Node.js、安装依赖、（组件齐备时拉起公司网关代理）启动本地服务，并尝试打开浏览器。

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
chmod +x start.command start-desktop.command stop.command stop-desktop.command start.sh stop.sh
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

### 桌面版（Electron，源码运行）

不想装 DMG、又要用桌面壳的原生能力（本机原片登记、原生文件选择）时，双击：

```text
start-desktop.command
```

与 `start.command` 的区别：

- 启动的是 Electron 桌面壳 + 私有 Node 服务跑 **production standalone 构建**，不是 dev server；服务监听 `127.0.0.1` 的随机端口，不占用 3000。
- 首次运行会自动执行一次 `npm run build`（需要几分钟）。之后复用已有产物，**代码更新后要显式重建**：

  ```bash
  ./start-desktop.command --rebuild
  ```

- 组件齐备时同样会先拉起 LiteLLM 代理，因此公司供应商可用（这一点与安装版不同，见 [MACOS.md](./MACOS.md)）。
- 数据根仍是本项目目录，与网页版共用同一个 `data/workbench.db`；脚本检测到 3000 端口被占用时会提示先停掉网页版，请不要同时运行两者。

退出方式（任选其一）：

- 应用菜单选择「退出」——关闭窗口只是隐藏，不会结束后台任务。
- 界面右上角的电源按钮「停止服务并退出」——服务停止后应用会自动退出。
- 直接关闭启动它的终端窗口，或按 `Ctrl+C`。
- 双击 `stop-desktop.command`——用于应用失去响应，或从 Finder 启动后没有终端窗口可用的情况。它同时覆盖源码态和安装版，会先校验实例身份再请求优雅关闭，之后才做有界的兜底回收。

注意 `stop.command` 只负责网页版（3000 端口），停不了桌面版监听随机端口的私有服务。

## 首次使用

1. 打开 `/settings`。
2. 添加图片供应商：公司网关场景填 `http://127.0.0.1:4000` + `gateway-task-image` 类型；其他场景可用 Packy、GeekAI 或 OpenAI-compatible 图片接口。
3. 填写 Base URL、API Key、模型名和默认单图成本。
4. 只启用当前要测试的供应商，避免误用其他余额。
5. 返回首页，新建复杂结构产品项目。

API Key 会存储在本地 SQLite 数据库中，前端列表只显示是否已配置，不显示明文 Key。

## 测试

没有 `npm test` 脚本。测试是 `scripts/` 下的独立文件，用 Node 22+ 直接运行：

```bash
node scripts/db-migrations.test.ts    # 运行单个测试文件
node scripts/<name>.test.ts           # 其余同理
```

约定：`node:assert/strict` 断言、无测试框架；数据库测试用 `:memory:` 实例；文件类测试用临时目录；改动某个模块时优先跑同名测试文件。

## 常用命令

```powershell
npm run dev        # 开发服务器
npm run lint       # ESLint
npm run build      # 生产构建（含 standalone 资源同步）
npm run start      # 生产服务器
```

## Windows 安装包

提供 Inno Setup 编译的一键安装程序，内置私有 Node.js 运行时，用户无需安装 Node/npm。

```powershell
npm run build:win-installer
```

安装包输出到 `dist/windows/CreativeStudioSetup.exe`。安装后可从桌面或开始菜单启动，默认卸载保留本地数据。

## macOS 安装包

提供 Apple Silicon 专用的 Electron DMG，内置私有 Node.js 运行时，用户拖到 Applications 后即可从 Finder 启动。

```bash
npm run build:mac-installer
```

安装包输出到 `dist/macos/产品素材工作台-<version>.dmg`。正式分发需要 Developer ID 签名与公证；详细说明见 [MACOS.md](./MACOS.md)。

## 目录结构

```text
app/                    Next.js 页面和 API 路由
components/             工作台 UI 组件（components/mixcut/ 为第五步智能混剪）
components/ui/          通用 UI 原语和图标
installer/windows/      Windows 安装包脚本和配置
installer/macos/        macOS .app 元数据与历史启动资源
lib/                    数据库、队列、供应商适配器、文件导出等核心逻辑
lib/final-edit/         智能混剪后端（时间线、TTS、字幕对齐、ffmpeg 渲染）
lib/providers/          图片生成供应商适配器
lib/script-providers/   脚本生成供应商适配器
lib/video-providers/    视频生成供应商适配器
docs/                   设计、评审和实现记录
outputs/                阶段性规格、测试清单和交付记录
scripts/                启停辅助脚本、测试文件、安装包构建脚本
types/                  第三方包类型补丁
```

## 本地数据和安全

这些目录或文件属于本机运行数据或密钥，不应提交或打包给别人（均已被 `.gitignore` 排除）：

```text
node_modules/
.next/
data/
storage/
.env.local
config.yaml
.venv-litellm/
```

原因：

- `node_modules` 包含 Windows/Mac/Linux 不同的原生二进制依赖。
- `.next` 是 Next.js 构建缓存。
- `data/` 包含本地 SQLite 数据库，保存供应商配置与 API Key。
- `storage/` 包含上传素材、生成图片、视频和日志。
- `.env.local` 包含 LLM API Key 与腾讯云 COS 密钥。
- `config.yaml` 包含公司网关 API Key；`.venv-litellm/` 是本地 Python 环境。

干净迁移方式：从 GitHub 下载源码，在目标机器运行 `npm ci`、`start-windows.cmd` 或 `start.command`，重新放置 `.env.local` 与 `config.yaml`，再到 `/settings` 重新配置供应商。

## 适用场景

- 电商产品场景图批量生产
- 家居、消费品、复杂结构产品的分镜素材管理
- 短视频脚本和分镜图文对照
- 智能混剪批量产出成片
- 多供应商 API 测试和成本控制
- 本地私有素材工作流

## 状态

当前项目仍在快速迭代中，重点方向是复杂结构产品的图片生产、分镜管理、脚本生成、视频任务与智能混剪成片链路。

## 许可证

Copyright (C) 2026 liangpeijian

本项目以 [GNU General Public License v3.0 only](./LICENSE) 授权。你可以使用、修改和分发本项目；如果向他人分发本项目或其修改版本，需要遵守 GPL-3.0 的条款并提供相应源码。

本项目调用的第三方服务、生成模型及其输出可能适用各自独立的服务条款或许可证，不因本项目采用 GPL-3.0 而自动改变。
