# Windows 安装包重试交接：目标、内容清单与已排雷记录

日期：2026-08-06
分支：`linsygroup`
面向：接手重试 Windows 安装包构建的 AI / 工程师

## 一句话现状

安装包**除了最后一步 Inno Setup 压缩被企业杀毒软件拦截外，其余全部完成并验证通过**。接手者的核心任务只有一个：在一台能写未签名 exe 的环境里完成压缩，或拿到杀软白名单/代码签名证书。

## 产品边界（已确认，不要改）

- 公司内部使用，Windows 10/11 x64，每用户安装，不要求管理员权限。
- 保留浏览器界面，不引入 Electron。
- 安装包自带 Node、FFmpeg/FFprobe、Python 和 LiteLLM；终端用户不安装任何开发环境。
- 应用和 LiteLLM 只监听 `127.0.0.1`，绝不暴露公网端口；参考图公网交付只走腾讯云 COS。
- 首次启动导入一份 AES-256-GCM 加密的 `.provision` 配置文件；再次导入覆盖受管供应商实现 Key 轮换。
- 卸载默认保留本地数据（项目、配置），"彻底删除"才清理。

## 安装包必须包含的内容

| 内容 | 版本/来源 | 校验 |
|---|---|---|
| Next.js standalone 应用 | `npm run build` 产物 | 启动冒烟：主页 200、`/api/provisioning` 200、SQLite 初始化 |
| 私有 Node 运行时 | Node `22.22.3` win-x64 官方 zip | SHA-256 `6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33` |
| 私有 Python + LiteLLM sidecar | CPython `3.12.10` embeddable + LiteLLM `1.89.2`（离线 wheel 组装） | Python zip SHA-256 `4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3`；pip wheel SHA-256 `382ff9f685ee3bc25864f820aa50505825f10f5458ffff07e30a6d96e5715cab`；`manifest.json` 断言版本与架构 |
| FFmpeg / FFprobe | `ffmpeg-static` / `ffprobe-static` npm 包 | 构建脚本断言二进制存在 |
| sharp / better-sqlite3 原生模块 | sharp `0.35.x`（`@img/sharp-win32-x64`） | 构建时用包内 node.exe 跑原生自检 |
| 启停与 sidecar 脚本 | `installer/windows/*.ps1` | 静态合同测试 `scripts/windows-installer.test.mjs` |
| C# 启动器 | `installer/windows/launcher.cs` → `CreativeStudio.exe` | 构建时用 .NET Framework csc.exe 编译 |
| provisioning 导入能力 | `lib/provisioning/` + 设置页导入卡片 | `scripts/provisioning.test.ts` 6/6 |

**绝不包含**（构建脚本有递归断言，触发即拒绝构建）：`.env*`、真实 `config.yaml` / `litellm-config.yaml`、`*.provision`、`company-profile*.local.json`、`runtime.env`、`data/`、`storage/`、`outputs/`、`.git/` 及任何用户数据。

## 构建命令

```powershell
# 在仓库根目录，构建机需 Node 22.x x64
$env:FFMPEG_BINARIES_URL='https://cdn.npmmirror.com/binaries/ffmpeg-static'  # 见坑 2
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-win-installer.ps1
```

产物：`dist/windows/CreativeStudioSetup.exe`（约 360 MB）。Inno Setup 6 需已安装（`iscc.exe` 在 PATH 或传 `-InnoSetupCompiler`）。

## 已排掉的坑（修复已提交，勿重复踩）

1. **LiteLLM cost map 联网超时打断构建**：sidecar 自检 `import litellm` 会拉取 `raw.githubusercontent.com` 的 model cost map，公司网络超时，stderr 警告被 PowerShell 5.1 提升为终止错误。已在 `scripts/build-litellm-sidecar.ps1` 与两个启动脚本内置 `LITELLM_LOCAL_MODEL_COST_MAP=True`。
2. **`npm ci` 阶段 ffmpeg 二进制下载超时**：`ffmpeg-static` postinstall 默认从 GitHub Releases 下载。用 `FFMPEG_BINARIES_URL` 指向 npmmirror CDN 镜像（内容一致，已验证可用）。
3. **`.provision` 被全项目 trace 带进 payload**：Turbopack NFT 因若干动态 `fs.readFileSync` 把整个仓库 trace 进 standalone。已在 `scripts/build-win-installer.ps1` 加针对性清理列表（根目录 `*.md` 通配 + 源码/文档/截图目录），禁止打包敏感文件的断言保留兜底。**生成 `.provision` 后不要放在仓库根目录**（当前交付文件在构建机 `C:\Users\12089\provision-delivery\`）。
4. **eslint 误报**：`.venv-litellm/**`、`.litellm-runtime/**`（第三方 venv/运行时里的 minified JS）已加入忽略。
5. **`.ps1` 编码**：所有 `scripts/*.ps1`、`installer/windows/*.ps1` 必须 UTF-8 **带 BOM**（PS 5.1 按 ANSI 读无 BOM 的中文会解析失败）。多数编辑器/AI 编辑工具会吃掉 BOM，改完务必检查（静态测试会拦）。
6. **MSYS/Git Bash 调用 ISCC 参数被路径转换吞掉**：如从 Git Bash 调 `iscc`，必须前置 `MSYS2_ARG_CONV_EXCL="*"`。

## 唯一未解决的问题：Inno 压缩被企业杀软拦截（核心卡点）

- **现象**：ISCC 走到 "Updating icons (Setup.exe)" 必报 `The output file appears to be in use (5)` → `Resource update error: EndUpdateResource failed`。压缩本身没开始。
- **根因判断**：构建机的 Symantec Endpoint Protection 和"无边界安全系统防护"（企业 EDR，Windows Defender 处于被动模式）拦截**对未签名 exe 的资源写入 API**（`EndUpdateResource`）。Inno 写图标/版本信息/manifest 必须调这个 API，无法绕过。
- **已排除的假设**：文件名锁定（换名当时成功过一次，后来也被封）、目录锁定（临时目录、全新目录同样被封）、进程残留（无）。同一台机器 `csc.exe` 直接编译 exe、手动创建/改写 exe 都正常——只有资源更新 API 被拦，且拦截规则在多次尝试后明显升级。
- **可选解法**（按推荐排序）：
  1. 找 IT 把 `ISCC.exe`（或构建输出目录）加进 SEP/无边界白名单；
  2. 公司提供 Windows 代码签名证书，签名后信誉拦截大概率解除（同时消除终端 SmartScreen"未知发布者"）；
  3. 换一台不装企业杀软的机器：只需把构建好的 payload 目录 `dist\windows\CreativeStudio` 拷过去，装 Inno Setup 6 后跑 `iscc installer\windows\CreativeStudio.iss`；
  4. 评估更换打包器（7z SFX 只拼接不改资源、MSIX 需签名），但会丢失 Inno 的卸载注册表/每用户安装语义，需重新设计启停与卸载脚本，工作量大。
- **注意**：Inno Setup 当前在本机显示 `Non-commercial use only`，公司内部商用分发前需评估/购买许可证。

## 当前构建机状态

- `dist\windows\CreativeStudio\` 里有一次完整通过的 payload（含 provisioning 修复，约 1.5 GB 展开），但**不含** `b0b72d8`（第三方供应商移除 + `.litellm-runtime` 支持）——重试前请先 `git pull` 并重新跑完整构建，不要直接用旧 payload。
- 曾产出过一个完整 `CreativeStudioSetup.exe`（SHA-256 `f37a6fd43f1703de7c4276c0491f7f138529f8825c64c1149b5d2e9b848af39e`，360 MB），内容与当前分支已不一致，**不要分发**。

## 交付前验证清单

1. 最终 exe 计算 SHA-256 并记录；`(Get-AuthenticodeSignature ...).Status` 确认签名状态。
2. 对展开 payload 递归扫描敏感文件（`.env*`、`*.provision`、`config.yaml`、`company-profile*.json`、`runtime.env`）。
3. 用 payload 内 `runtime\node.exe server.js` 真实启动：主页 200、provisioning API 200、SQLite 创建、进程可正常关停。
4. 找一台干净 Windows 10/11 x64：安装 → 首次导入 `.provision` → 重启 → Key 轮换再导入 → 停止 → 卸载保留数据，全链路各验一次。
5. 费用授权后再做真实图片/脚本/视频/TTS 端到端调用。

## 相关文档

- 安装包与 provisioning 设计：`docs/superpowers/specs/2026-08-05-windows-installer-provisioning-spec.md`
- 昨晚交接（依赖升级、已确认边界）：`docs/2026-08-05-windows-installer-handoff.md`
- provisioning 导入修复与源码部署：`docs/2026-08-06-provisioning-import-fix-and-source-deployment.md`
- 管理员制作 `.provision`：`provisioning/README.md`
