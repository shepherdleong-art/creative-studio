# Windows 内部安装包与统一配置导入：阶段交接

日期：2026-08-05
当前分支：`linsygroup`

## 当前结论

今晚已完成 Windows 内部安装包、私有 LiteLLM sidecar 和加密配置导入的主体实现。应用的展开负载曾通过真实启动冒烟测试；在随后处理生产依赖安全公告并升级 Next.js/Sharp 后，Next.js 16.3.0 的生产编译、类型检查、原生模块自检和 Inno Setup 前的 payload 安全检查均已通过。

最终安装程序的重新压缩按用户要求暂停，Inno Setup 进程已停止。因此当前 `dist/windows/CreativeStudioSetup.exe` 不得视为最终交付物，明天需要重新完成一次安装器构建、哈希与真实启动验证。

真实 `config.yaml`、`.env.local`、COS/API Key、生成的 `.provision` 和用户数据都没有加入 Git，也不会进入 installer payload。

## 已确认产品边界

- 公司内部使用，Windows 10/11 x64。
- 每用户安装，不要求管理员权限。
- 保留浏览器界面，不引入 Electron。
- 安装包自带 Node、FFmpeg/FFprobe、Python 和 LiteLLM；终端用户不安装开发环境。
- 应用和 LiteLLM 只监听 `127.0.0.1`，不暴露公网端口。
- 首次启动导入一份加密配置文件；后续允许重新导入并覆盖受管供应商，以支持 Key 轮换。
- 首版多人共用一套凭据，不做每用户 Token、服务端计费和自动更新。

## 今晚完成的实现

### 1. 加密配置交付与导入

- 新增严格版本化的 provisioning v1 schema。
- 使用 `scrypt + AES-256-GCM`；随机 salt/IV，GCM 认证防篡改。
- 密码最少 12 个字符；加密文件上限 2 MiB；错误密码、篡改、超限和非法字段在持久化前失败。
- 导入会原子更新 LiteLLM `config.yaml`、受控 runtime env、非秘密状态和本地供应商记录；失败时回滚文件和数据库。
- 重复导入只覆盖稳定 ID 对应的受管供应商，不删除用户自行添加的其他供应商。
- 设置页和首页增加统一配置导入入口；API/UI 不回显 Key 或 `config.yaml` 内容。
- 新增管理员 CLI 和无秘密示例，可从独立 `config.yaml` 与本地 profile 生成 `.provision`。

核心文件：

- `lib/provisioning/`
- `app/api/provisioning/route.ts`
- `components/provisioning/ProvisioningImportCard.tsx`
- `scripts/create-provision-package.ts`
- `provisioning/README.md`
- `provisioning/company-profile.example.json`

### 2. Windows 私有运行时与生命周期

- LiteLLM 固定为 `1.89.2`。
- 私有运行时固定 CPython `3.12.10` x64，通过官方 embeddable ZIP 和固定 pip wheel 离线组装，不依赖终端机器 Python/pip。
- 私有 Node 固定 `22.22.3` x64。
- sidecar 固定 `127.0.0.1:4000`、单 worker；健康检查失败时只禁用公司代理，不阻塞主应用。
- 启动、停止、UI shutdown 和卸载前步骤按受控 PID/可执行文件/命令行边界回收 Node 与 LiteLLM。
- PowerShell 运行脚本保持 UTF-8 BOM，兼容 Windows PowerShell 5.1 中文解析。
- 构建脚本校验下载文件 SHA-256、LiteLLM manifest、FFmpeg/FFprobe、Sharp/libvips 和 better-sqlite3 原生模块。
- payload 递归拒绝 `.env*`、真实 `config.yaml`、`.provision`、本地 profile、runtime env 和用户数据目录。

核心文件：

- `scripts/build-litellm-sidecar.ps1`
- `scripts/build-win-installer.ps1`
- `installer/windows/start-company-sidecar.ps1`
- `installer/windows/stop-company-sidecar.ps1`
- `installer/windows/start-installed.ps1`
- `installer/windows/stop-installed.ps1`
- `installer/windows/launcher.cs`

### 3. 依赖安全收口

- Next.js / `eslint-config-next` 从 `16.2.7` 升至 `16.3.0`。
- Sharp 从 `0.34.5` 升至 `0.35.3`，并把安装器断言改为识别 0.35 的版本化原生模块与 libvips DLL 文件名。
- `npm audit` 在完整依赖树和 `--omit=dev` 生产依赖树上均为 0 个已知漏洞。
- Next.js 16.3.0 已完成生产编译和 TypeScript 检查。

## 本机配置只读核验结果

以下仅记录结构，不记录任何密钥值：

- `config.yaml` 和 `.env.local` 均已被 Git 忽略。
- `config.yaml` 可解析，检测到模型别名：
  - `image2-medium`
  - `GPT-5-5`
  - `kling-3.0`
  - `doubao-seedance-2-0-260128`
- 脚本模型文档声明使用 `/v1/chat/completions`，因此首版脚本供应商应使用 `openai-compatible` 协议。
- COS 所需变量完整存在于 `.env.local`。
- 当前缺少 `DOUBAO_TTS_API_KEY`；本地数据库中的豆包 TTS 供应商也没有已保存 Key。
- 使用虚拟 TTS Key 做过严格 profile dry-run，现有 YAML、COS 参数和模型别名均通过校验。

## 已完成验证

- provisioning 测试：5/5 通过。
- provider execution gate 测试通过。
- media transport 合同测试通过。
- LiteLLM sidecar 静态合同测试通过。
- Windows installer 静态合同测试通过；Sharp 0.35 文件布局补丁后的专项测试也通过。
- ESLint：0 error，42 个 warning；其中 41 个为原有告警，Next.js 16.3 新增 1 条内部导航规则告警。
- 固定运行时版本：Node `22.22.3`、Python `3.12.10`、LiteLLM `1.89.2`。
- 旧依赖版本负载曾通过真实启动冒烟：主页 200、provisioning API 200、SQLite 创建成功、进程保持运行。
- 升级后负载已通过 Next 16.3 编译、类型检查、Sharp/better-sqlite3 原生自检和敏感文件检查；最终 EXE 压缩与升级后真实启动尚未完成。

## 明天继续前仍需输入或决策

1. 在本机 `.env.local` 中补充真实 `DOUBAO_TTS_API_KEY=...`，不要在聊天或 Git 中发送。
2. 确认 GPT-5.5 多模态网关合同：
   - Chat Completions 是否接受 `image_url`；
   - 是否接受 data URL，还是必须使用 COS 预签名 URL；
   - 单请求图片数量/大小限制和 URL TTL；
   - 视频分析是否接收视频 URL，或只接收抽帧图片。
3. 确定共享 `.provision` 的导入密码，并通过独立安全渠道交付给用户。
4. 如需避免 SmartScreen 的“未知发布者”，提供公司 Windows 代码签名证书；当前安装器未签名。
5. 公司需评估/购买 Inno Setup 商业许可证；本机构建工具当前显示 `Non-commercial use only`。
6. 明确授权后再执行会产生费用的图片、脚本、视频和 TTS 真实端到端调用。

### GPT-5.5 素材分析的当前边界

公司范围的含媒体请求目前会 fail closed：脚本文图请求和批量素材内容分析没有正式 `MediaTransport` 时不会绕过安全门禁。纯文本 GPT-5.5 脚本可以工作，但“带图片的脚本生成”和“素材内容理解”必须在确认上述网关合同后接入正式媒体租约。不要通过把公司供应商伪装成 external 来绕过门禁。

## 本机遗留清理待授权

早期 sidecar 构建方案的一次命令行路径分割误将完整 Python 3.12.10 安装到了 `E:\creative`，并可能写入系统卸载登记。自动安全审核拒绝直接执行静默卸载，因为它可能同时移除系统登记的同版本 Python 组件。

该目录仍保留。明天只有在用户明确授权“使用刚下载的官方 Python 3.12.10 安装器执行卸载，并接受可能移除系统登记同版本组件的风险”后才能处理；不得直接递归删除或绕过卸载器。

## 明天建议顺序

1. 补齐豆包 Key，确认 GPT-5.5 媒体合同与导入密码。
2. 用真实配置做 LiteLLM 本机健康检查和 `/v1/models` 检查；不调用计费接口。
3. 接通并验证正式 `MediaTransport`。
4. 重新运行 focused tests、lint、`npm audit`。
5. 使用固定 Node 22 完成安装器构建。
6. 对最终 `CreativeStudioSetup.exe` 计算 SHA-256、检查 Authenticode、递归扫描敏感文件。
7. 用最终展开负载和一台干净 Windows 10/11 x64 机器各做一次安装、首次导入、重启、Key 轮换、停止和卸载保留数据验证。
8. 在明确授权费用后做真实图片、GPT-5.5、可灵、即梦/Seedance 与豆包 TTS E2E。

本机缓存仍在时，可从固定 Node 22 继续构建：

```powershell
$installerNodeDir = (Resolve-Path '.cache/windows-installer/node-v22.22.3-win-x64').Path
$env:PATH = "$installerNodeDir;$env:PATH"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-win-installer.ps1 `
  -SkipNpmCi `
  -SkipLiteLLMSidecarBuild `
  -InnoSetupCompiler '.cache/windows-installer/tools/inno-6.7.3/ISCC.exe'
```

如缓存或依赖状态不确定，不使用两个 `Skip` 参数，重新执行完整构建。

## 相关规格与计划

- `docs/superpowers/specs/2026-08-05-windows-installer-provisioning-spec.md`
- `docs/superpowers/plans/2026-08-05-windows-installer-provisioning.md`
