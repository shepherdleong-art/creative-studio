param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Executable = Join-Path $Root 'CreativeStudio.exe'
$ResolvedExecutable = [System.IO.Path]::GetFullPath($Executable)
$desktopServiceTool = Join-Path $ScriptDir 'runtime\desktop-service.mjs'
$processTreeTool = Join-Path $ScriptDir 'runtime\process-tree.mjs'
$nodeExe = Join-Path $Root 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
  Write-Host '未找到内置 Node 运行时(runtime\node.exe),无法执行共享停机工具。请重新安装产品素材工作台。' -ForegroundColor Red
  exit 1
}

Write-Host '正在停止产品素材工作台…'
$DataRoots = @()
if ($env:CREATIVE_STUDIO_DATA_ROOT) { $DataRoots += $env:CREATIVE_STUDIO_DATA_ROOT }
$DataRoots += $Root
if ($env:APPDATA) { $DataRoots += (Join-Path $env:APPDATA 'CreativeStudio') }

# ── electron-service.json 校验 + instanceId 核身 + 优雅停机链:逐受控数据根委托共享工具 ──
# 工具内部红线:origin 严格校验 127.0.0.1、instance 不匹配绝不请求/绝不杀、属主不明只报告。
$gracefulDone = $false
$stopFailed = $false
foreach ($dataRoot in ($DataRoots | Select-Object -Unique)) {
  $outLines = @(& $nodeExe $desktopServiceTool stop --root $dataRoot)
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    if ($outLines -contains 'state=found') {
      $gracefulDone = $true
      Write-Host "数据根 $dataRoot 的桌面服务已停止。"
    } else {
      Write-Host "数据根 $dataRoot 没有桌面服务状态文件。"
    }
  } elseif ($code -eq 2) {
    Write-Host "数据根 $dataRoot 的桌面服务实例不匹配或属主不明，只报告未强制（不误杀）。" -ForegroundColor Yellow
  } else {
    Write-Host "数据根 $dataRoot 的桌面服务停止失败(退出码 $code)，请检查安装包完整性。" -ForegroundColor Red
    $stopFailed = $true
  }
}

# ── 兜底:按安装目录可执行路径匹配本实例的桌面壳进程,归属确认后强杀整棵树 ──
# 优雅停机成功后壳进程可能仍存活(服务子进程先退出),此时同样只杀确认归属的进程。
function Get-MatchedProcesses {
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='CreativeStudio.exe'" -ErrorAction SilentlyContinue)
  return @($processes | Where-Object {
    $processExecutable = $null
    if ($_.ExecutablePath) {
      try { $processExecutable = [System.IO.Path]::GetFullPath([string]$_.ExecutablePath) } catch { $processExecutable = $null }
    }
    $processExecutable -and $processExecutable -ieq $ResolvedExecutable
  })
}

$matchedProcesses = @(Get-MatchedProcesses)
foreach ($process in $matchedProcesses) {
  Write-Host "强制停止桌面壳进程: $($process.ProcessId)"
  & $nodeExe $processTreeTool kill-tree $process.ProcessId 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "强制结束失败(退出码 $LASTEXITCODE): $($process.ProcessId)" -ForegroundColor Red
    $stopFailed = $true
  }
}

if ($matchedProcesses.Count -gt 0) {
  Write-Host '产品素材工作台及其私有服务进程树已强制停止。' -ForegroundColor Yellow
} elseif ($gracefulDone) {
  Write-Host '产品素材工作台已完成优雅停机。' -ForegroundColor Green
} else {
  Write-Host '未找到当前安装目录对应的运行实例。' -ForegroundColor Yellow
}

if ($stopFailed) { exit 1 }
