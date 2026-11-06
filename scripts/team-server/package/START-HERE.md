# Creative Studio 服务器统一生产包 · 从这里开始

这个目录是**服务器主包**，不是员工客户端。员工客户端是单独分发的轻客户端目录，入口为 `start-client.cmd`；管理网页与员工网页共用同一个 HTTPS 入口。

包内不含数据、日志、真实配置、API Key、证书私钥或部署私钥。所有运行命令都使用包内运行时，不依赖源码目录或开发机全局工具。

## 1. 包结构

| 路径 | 用途 |
| --- | --- |
| `runtimes\node\node.exe` | 锁定 Node 运行时；所有 CLI 必须使用它 |
| `tools\caddy\caddy.exe` | HTTPS 入口 |
| `tools\winsw\WinSW.exe` | Windows 服务包装器 |
| `app\` | Next.js standalone 应用与运维脚本 |
| `service\` | 预检、安装、启停、状态、备份、计划任务与发布脚本 |
| `release-manifest.json` | 本包 releaseId、sourceCommit、逐文件哈希 |
| `deployment.example.json` | 部署配置模板；路径、端口、账号与网络均为示例，必须按现场修改 |

`releaseId` 必须与 `release-manifest.json` 一致；不要改目录名冒充其他版本。

## 2. 开始前必须准备的输入

1. 本机已安装受信 HTTPS 证书与私钥文件（路径必须绝对路径，且服务账号可读）。
2. 部署 ID（本机唯一，例如 `studio-prod`）、数据根、备份根、部署根（三者互不重叠）。
3. 精确 HTTPS origin，例如 `https://studio.example.internal`；不得带路径、查询或末尾斜杠。
4. 无口令 gMSA 或受限内置服务账号，以及允许访问的內网 CIDR。
5. 若启用公司 LiteLLM：已验收的 `python-runtime` 与网关配置由部署流程单独准备；本包不附带秘密。
6. 客户端正式发布还需要受控的 Ed25519 签名私钥与对应公钥；缺少时只能生成测试包，不能称为正式交付。

## 3. 配置 → 预检 → 安装 → 就绪

先把**整个包**放到部署根下的 release 目录，目录名必须等于 `release-manifest.json` 的 `releaseId`：

```text
<deploymentRoot>\releases\<releaseId>\
```

在本包根打开**管理员 PowerShell**：

```powershell
$releaseRoot = (Get-Location).Path
$deploymentRoot = Split-Path (Split-Path $releaseRoot -Parent) -Parent
$configDirectory = Join-Path $deploymentRoot 'config'
New-Item -ItemType Directory -Force $configDirectory | Out-Null
$configPath = Join-Path $configDirectory 'deployment.json'
if (Test-Path -LiteralPath $configPath) { throw '配置已存在，请核对，不要覆盖' }
Copy-Item .\deployment.example.json $configPath
notepad $configPath
```

配置、预检报告和运行状态必须放在 release 目录之外，否则完整清单校验会拒绝未登记文件。按实际环境填写后先跑预检（只读检查，报告写入指定目录）：

```powershell
.\service\preflight.ps1 -ConfigPath $configPath -OutputDirectory (Join-Path $deploymentRoot 'preflight')
```

预检报告 `preflight-report.json` 的 `status` 必须为通过；`pending-create` 表示目录将通过安装创建，其他错误先修正再继续。

安装分两步；第一步只输出计划：

```powershell
.\service\install.ps1 -ConfigPath $configPath
.\service\install.ps1 -ConfigPath $configPath -Apply
```

需要首次就启用每日备份时：

```powershell
.\service\install.ps1 -ConfigPath $configPath -Apply -EnableDailyBackup -BackupTime 02:30
```

安装会等待 `http://127.0.0.1:<appPort>/api/team/health/ready` 有界返回；结果写入 `<deploymentRoot>\service\install-state.json`。随后检查状态：

```powershell
.\service\status.ps1 -ConfigPath $configPath -Apply
```

## 4. 初始化管理员与开通成员

使用包内 Node 和部署配置初始化首管理员（一次性凭据只显示本次）：

```powershell
.\service\admin-cli.ps1 -ConfigPath $configPath -Command init-admin -Arguments '--employee-id','0001','--name','系统管理员'
```

打开 `<origin>/team/login`，用工号与一次性凭据登录并立即改密。之后在管理页面完成：

- `<origin>/settings`：先配置供应商及开放模型。
- `<origin>/team/admin/pools`：为已配置的图片/视频/脚本/TTS/画布身份绑定真实资源池与容量。
- `<origin>/team/admin/resources`：发布公共资源。
- `<origin>/team/admin/users`：成员、额度与并发策略；新账号默认零额度、零并发，必须显式授权。
- `<origin>/team/admin/operations`：查看模块开关与运维入口状态。

供应商与资源池必须走上述正式页面/API，不要直接改数据库。

## 5. 备份、恢复与计划任务

```powershell
.\service\backup.ps1 -ConfigPath $configPath -Type daily -Apply
.\service\schedule-backup.ps1 -ConfigPath $configPath -Action preview
.\service\schedule-backup.ps1 -ConfigPath $configPath -Action status
```

`preview` 不写系统；`-Action apply` 才注册本部署专属任务，运行账号的登录类型由脚本生成并须在目标机核验；无人登录运行需现场验证。重复执行只管理同名且归属本部署的任务，遇到同名陌生任务会拒绝覆盖。

恢复演练必须使用尚不存在的全新目录，并保留 restore hold 直到对账完成：

```powershell
.\service\restore.ps1 -ConfigPath $configPath -BackupType daily -BackupId <backupId> -RestoreRoot D:\restore-check
```

## 6. 轻客户端更新发布

先用 `build-team-client` 在构建机生成测试或正式客户端包。发布到本机受控目录时，把服务端 origin 与构建产物目录传给它：

```powershell
.\runtimes\node\node.exe .\service\publish-client-update.mjs `
  --source <构建机产出的客户端目录> `
  --deployment-root "$deploymentRoot" `
  --origin <deployment.json中的完整HTTPS-origin>
```

发布顺序固定为 ZIP → 版本 manifest → `current.manifest.json` 指针；只有签名和哈希都验证通过才会替换指针。托管目录由 Caddy 以只读静态文件暴露，私钥与部署配置不可读取。

## 7. 停止与重启

```powershell
.\service\stop.ps1 -ConfigPath $configPath
.\service\stop.ps1 -ConfigPath $configPath -Apply
```

`stop.ps1` 默认只预览；`-Apply` 才会按记录停止 app、可选 LiteLLM 与 Caddy。关闭员工客户端窗口不会停止服务器。

## 8. 常见失败定位

| 现象 | 先看 |
| --- | --- |
| 预检报 `RELEASE_MANIFEST_*` | `release-manifest.json` 与本包文件不一致，重新解压完整包 |
| 预检报 `CERTIFICATE_*` | 证书/私钥路径、管理员可读性与 ACL |
| 安装停在 `ready` | `<deploymentRoot>\service\install-state.json`、`<dataRoot>\storage\logs\services` |
| 登录提示“客户端版本不再受支持” | 更新入口未配置或客户端过旧；查看 `/team/admin/operations` |
| 资源池阻塞 | `/team/admin/pools` 中按提示绑定池并设置容量 |
| 备份任务未运行 | `.\service\schedule-backup.ps1 -ConfigPath $configPath -Action status` 的 `dailyJob` 与 `lastTaskResult` |
| 恢复后仍阻断付费 | 这是预期的 restore hold；完成对账后才可解除 |

真实 SCM、服务账号、无人登录、GPU/NVENC、证书信任、两台物理设备与正式签名仍必须按现场验收清单签收；本包内测试不代表生产签收。
