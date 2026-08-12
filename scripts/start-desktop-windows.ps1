# 桌面版（Electron）一键启动脚本，供 start-windows.cmd 调用。
# 与 start-windows.ps1（网页版）的区别：
#   - 这里启动的是 Electron 桌面壳 + 私有 Node 服务跑 production standalone 构建，
#     不是 dev server；服务监听 127.0.0.1 的随机端口，不占用 3000。
#   - 源码态运行时数据根仍是本项目目录（data/、storage/），与网页版共用同一个数据库。
# 停止：在应用菜单选择「退出」，或关闭本窗口。本机服务不得暴露到公网。
param(
  # 强制重新执行 npm run build（代码更新后使用）
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
Set-Location $Root

Write-Host '========================================'
Write-Host '  批量图片编辑工作台 - Windows 桌面版'
Write-Host '========================================'
Write-Host ''

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '未找到 Node.js。请先安装 Node.js LTS: https://nodejs.org' -ForegroundColor Red
  exit 1
}

# 显式锁定私有 Node 服务使用的运行时，双击启动环境的 PATH 未必与开发终端一致。
$env:CREATIVE_STUDIO_NODE = $node.Source

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Write-Host '首次运行，正在安装依赖，请保持联网...'
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) {
    Write-Host '依赖安装失败。请检查网络、npm registry 或杀毒软件拦截。' -ForegroundColor Red
    exit $LASTEXITCODE
  }
  Write-Host ''
}

# Electron 运行时二进制不随 npm 包元数据安装，缺失时显式补装后硬断言。
$electronBinary = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronBinary)) {
  Write-Host '正在安装 Electron 运行时...'
  $electronInstall = Join-Path $Root 'node_modules\electron\install.js'
  if (-not (Test-Path $electronInstall)) {
    Write-Host '缺少 electron 依赖，请先运行 npm ci。' -ForegroundColor Red
    exit 1
  }
  & node $electronInstall
  if (-not (Test-Path $electronBinary)) {
    Write-Host "Electron 运行时安装失败：$electronBinary" -ForegroundColor Red
    exit 1
  }
  Write-Host ''
}

# 桌面版和网页版共用 data/workbench.db；同时运行会有并发写入风险。
$webListener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($webListener) {
  Write-Host '检测到 3000 端口已被占用，网页版可能正在运行。' -ForegroundColor Yellow
  Write-Host '桌面版与网页版共用 data/workbench.db，同时运行有并发写入风险。'
  $reply = Read-Host '仍要继续启动桌面版？(y/N)'
  if ($reply -notmatch '^(y|Y)$') { exit 1 }
  Write-Host ''
}

# 公司供应商运行环境是可选 sidecar；失败只禁用公司供应商，不阻塞工作台。
$stackStarted = $false
$hasStackComponents = (Test-Path (Join-Path $Root '.venv-litellm\Scripts\litellm.exe')) -and
                      (Test-Path (Join-Path $Root 'config.yaml'))
if ($hasStackComponents) {
  Write-Host '检测到公司网关组件，启动 litellm 代理...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'start-stack.ps1') -SkipApp
  if ($LASTEXITCODE -ne 0) {
    Write-Host '公司网关组件启动失败，继续启动工作台。' -ForegroundColor Yellow
  } elseif (Test-Path (Join-Path $Root 'storage\run\stack.json')) {
    $stackStarted = $true
    Write-Host '公司网关代理就绪: http://127.0.0.1:4000'
  } else {
    Write-Host '公司网关状态文件缺失，正在清理 sidecar 并继续启动工作台。' -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
  }
  Write-Host ''
}

# 桌面壳要求 production standalone 产物存在，dev server 的产物不适用。
$standaloneServer = Join-Path $Root '.next\standalone\server.js'
$standaloneEntry = Join-Path $Root '.next\standalone\runtime\server-entry.js'
if ($Rebuild -or -not (Test-Path $standaloneServer) -or -not (Test-Path $standaloneEntry)) {
  if ($Rebuild) {
    Write-Host '正在重新构建工作台（-Rebuild）...'
  } else {
    Write-Host '未找到 standalone 构建产物，正在首次构建（需要几分钟）...'
  }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host '构建失败，请查看上方错误输出。' -ForegroundColor Red
    exit $LASTEXITCODE
  }
  Write-Host ''
} else {
  Write-Host "使用已有构建产物：.next\standalone\server.js（代码有更新时请运行 start-windows.cmd -Rebuild）"
  Write-Host ''
}

Write-Host '正在编译桌面壳...'
& npm.cmd run build:desktop
if ($LASTEXITCODE -ne 0) {
  Write-Host '桌面壳编译失败，请查看上方错误输出。' -ForegroundColor Red
  exit $LASTEXITCODE
}
Write-Host ''

Write-Host '正在启动桌面版...'
Write-Host ''
Write-Host '使用说明:'
Write-Host '  1. 服务只监听 127.0.0.1 的随机端口，不会暴露到公网'
Write-Host '  2. 关闭窗口只是隐藏，请从应用菜单选择「退出」结束后台任务'
Write-Host '  3. 直接关闭此窗口也会触发桌面版优雅退出'
Write-Host ''

# 桌面壳退出时会请求 /api/shutdown，那条链路已经会停掉受控的 LiteLLM；
# 这里的 finally 只是异常退出时的兜底，stop-stack.ps1 本身幂等。
try {
  & (Join-Path $Root 'node_modules\.bin\electron.cmd') .
  $desktopExitCode = $LASTEXITCODE
} finally {
  if ($stackStarted) {
    Write-Host ''
    Write-Host '正在关闭 litellm 代理...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
  }
}
exit $desktopExitCode
