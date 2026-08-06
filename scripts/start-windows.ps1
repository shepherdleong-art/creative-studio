param(
  [int]$Port = $(if ($env:BATCH_WORKBENCH_PORT) { [int]$env:BATCH_WORKBENCH_PORT } else { 3000 })
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
Set-Location $Root

Write-Host '========================================'
Write-Host '  批量图片编辑工作台 - Windows 启动器'
Write-Host '========================================'
Write-Host ''

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '未找到 Node.js。请先安装 Node.js LTS: https://nodejs.org' -ForegroundColor Red
  exit 1
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  Write-Host '未找到 npm。请确认 Node.js 已正确安装并重新打开 PowerShell。' -ForegroundColor Red
  exit 1
}

$nodeVersion = (& node -v).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
  Write-Host "当前 Node.js 版本是 $nodeVersion，建议安装 Node.js 20 或更高版本。" -ForegroundColor Red
  exit 1
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  Write-Host "端口 $Port 已被占用。" -ForegroundColor Yellow
  if ($proc) {
    Write-Host "PID: $($proc.ProcessId)"
    Write-Host "CommandLine: $($proc.CommandLine)"
  }
  Write-Host "如果这是本工作台，请先运行 stop-windows.cmd；如果要换端口，请运行："
  Write-Host '$env:BATCH_WORKBENCH_PORT=3001; .\start-windows.cmd'
  exit 1
}

$needsInstall = -not (Test-Path (Join-Path $Root 'node_modules'))
$sharpWin = Join-Path $Root 'node_modules\@img\sharp-win32-x64'
$sqliteWin = Join-Path $Root 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
if (-not $needsInstall -and (-not (Test-Path $sharpWin) -or -not (Test-Path $sqliteWin))) {
  Write-Host '检测到 node_modules 可能不是 Windows 环境安装的，准备重新安装依赖。' -ForegroundColor Yellow
  $needsInstall = $true
}

if ($needsInstall) {
  Write-Host '正在安装依赖，请保持联网...'
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) {
    Write-Host '依赖安装失败。请检查网络、npm registry 或杀毒软件拦截。' -ForegroundColor Red
    exit $LASTEXITCODE
  }
  Write-Host ''
}

# ── 公司网关联动：依赖就绪后再拉起可选 sidecar，失败不能阻塞工作台 ──
# 参考图公网交付走腾讯云 COS（见 .env.local 的 CREATIVE_STUDIO_COS_*）；本机服务不得暴露到公网。
$stackStarted = $false
$hasStackComponents = ((Test-Path (Join-Path $Root '.venv-litellm\Scripts\litellm.exe')) -or
                       (Test-Path (Join-Path $Root '.litellm-runtime\python.exe'))) -and
                      (Test-Path (Join-Path $Root 'config.yaml'))
if ($hasStackComponents) {
  Write-Host '检测到公司网关组件，启动 litellm 代理...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'start-stack.ps1') -SkipApp
  if ($LASTEXITCODE -ne 0) {
    # 公司 sidecar 是可选运行环境；失败只禁用公司供应商，工作台和外部供应商照常启动。
    Write-Host '公司网关组件启动失败，继续启动工作台。' -ForegroundColor Yellow
  } else {
    $stackFile = Join-Path $Root 'storage\run\stack.json'
    if (Test-Path $stackFile) {
      $stackStarted = $true
      Write-Host '公司网关代理就绪: http://127.0.0.1:4000'
    } else {
      # 已成功启动却查不到状态文件时，回收本轮 sidecar 后再降级启动工作台。
      Write-Host '公司网关状态文件缺失，正在清理 sidecar 并继续启动工作台。' -ForegroundColor Yellow
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
    }
  }
} else {
  $stackFile = Join-Path $Root 'storage\run\stack.json'
  if (Test-Path $stackFile) {
    # 新一轮启动缺少 sidecar 组件时，回收上次崩溃可能遗留的受控进程与状态。
    Write-Host '公司网关组件不完整，正在清理旧 sidecar 状态并继续启动工作台。' -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
  }
}

$url = "http://127.0.0.1:$Port"
Write-Host "访问地址: $url"
Write-Host '停止服务：在此窗口按 Ctrl+C，或运行 stop-windows.cmd。'
Write-Host ''

$devExitCode = 0
try {
  & npm.cmd run dev -- --hostname 127.0.0.1 --port $Port
  $devExitCode = $LASTEXITCODE
} finally {
  if ($stackStarted) {
    Write-Host ''
    Write-Host '正在关闭 litellm 代理...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
  }
}
exit $devExitCode
