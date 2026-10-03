# 一键停止 Creative Studio(网页版 + 桌面版)与 LiteLLM 代理。
# 停机顺序:状态文件校验后优雅停机(/api/shutdown)→ 等待端口释放 → 按项目归属强制清理。
# 状态文件缺失或失效时,按端口属主与进程特征兜底;但绝不结束与项目目录无关的进程。
# 端口探测/进程归属/状态文件/停机链统一委托 scripts/runtime/*.mjs 共享工具。
param(
  [int]$Port = $(if ($env:BATCH_WORKBENCH_PORT) { [int]$env:BATCH_WORKBENCH_PORT } else { 3000 })
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$runDir = Join-Path $Root 'storage\run'
$serviceFile = Join-Path $runDir 'electron-service.json'
$stackFile = Join-Path $runDir 'stack.json'
$rootPrefix = $Root.TrimEnd('\') + '\'

# ── 共享工具用 Node 执行:包内 node-runtime 优先,否则取 PATH(与 start-desktop-windows.ps1 一致)──
$bundledNode = Join-Path $Root 'node-runtime\node.exe'
if (Test-Path $bundledNode) {
  $nodeExe = $bundledNode
} else {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-Host '未找到 Node.js,无法执行共享停机工具。请先安装 Node.js 22.x,或使用含 node-runtime\node.exe 的完整安装。' -ForegroundColor Red
    exit 1
  }
  $nodeExe = $nodeCmd.Source
}
$portsTool = Join-Path $ScriptDir 'runtime\ports.mjs'
$processTreeTool = Join-Path $ScriptDir 'runtime\process-tree.mjs'
$desktopServiceTool = Join-Path $ScriptDir 'runtime\desktop-service.mjs'

function Get-ListenerPids([int]$TargetPort) {
  # 端口探测委托 ports.mjs;非零退出(工具不可用/参数错误)必须显式报错,不得静默继续。
  $lines = @(& $nodeExe $portsTool listeners $TargetPort)
  if ($LASTEXITCODE -ne 0) {
    Write-Host "端口探测失败(退出码 $LASTEXITCODE): $portsTool" -ForegroundColor Red
    exit 1
  }
  @($lines | ForEach-Object { if ($_ -match '^\s*(\d+)\s*$') { [int]$Matches[1] } } | Where-Object { $_ -gt 0 })
}

function Test-ProjectProcess([int]$TargetPid) {
  # 归属校验委托 process-tree.mjs(可执行路径或命令行归属本项目目录才算);
  # 退出码 1=不属于/已不存在(语义性,返回 false),其余=工具失败必须显式报错。
  & $nodeExe $processTreeTool check-owner $TargetPid $Root 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { return $true }
  if ($LASTEXITCODE -eq 1) { return $false }
  Write-Host "进程归属校验失败(退出码 $LASTEXITCODE): $processTreeTool" -ForegroundColor Red
  exit 1
}

function Wait-PortReleased([int]$TargetPort, [int]$TimeoutSec) {
  # 委托 ports.mjs 轮询等待;退出码 1=超时(语义性,返回 false),其余失败必须显式报错。
  & $nodeExe $portsTool released $TargetPort ($TimeoutSec * 1000) 2>$null
  if ($LASTEXITCODE -eq 0) { return $true }
  if ($LASTEXITCODE -eq 1) { return $false }
  Write-Host "端口释放等待失败(退出码 $LASTEXITCODE): $portsTool" -ForegroundColor Red
  exit 1
}

function Stop-PortOwners([int]$TargetPort, [string]$Label) {
  foreach ($ownerPid in (Get-ListenerPids $TargetPort)) {
    if (Test-ProjectProcess $ownerPid) {
      Write-Host "强制结束$Label进程 PID: $ownerPid"
      & $nodeExe $processTreeTool kill-tree $ownerPid 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Host "强制结束失败(退出码 $LASTEXITCODE): $ownerPid" -ForegroundColor Red
      }
    } else {
      Write-Host "端口 $TargetPort 的进程(PID $ownerPid)不属于本项目,跳过(不误杀)。" -ForegroundColor Yellow
    }
  }
}

Write-Host '[1/2] 停止 Creative Studio...'

# ── 桌面版服务:electron-service.json 校验 + 实例核身 + 优雅停机链委托共享工具(动态端口)──
# 退出码 0=正常停止/本就无记录;2=instance 不匹配或属主不明(只报告不动手);
# 属主不明发生在「优雅停机已请求但实例 20 秒未下线」时,按端口属主兜底强杀(仅限归属确认)。
$desktopServiceOut = @(& $nodeExe $desktopServiceTool stop --root $Root)
$desktopServiceExit = $LASTEXITCODE
$desktopShutdownRequested = $false
$desktopPort = 0
foreach ($line in $desktopServiceOut) {
  if ($line -eq 'action=shutdown-requested') { $desktopShutdownRequested = $true }
  if ($line -match '^origin=http://127\.0\.0\.1:(\d+)$') { $desktopPort = [int]$Matches[1] }
}
switch ($desktopServiceExit) {
  0 {
    Write-Host '桌面版服务已停止(或本就无状态文件)。'
  }
  2 {
    Write-Host '桌面版服务状态与运行实例不匹配或属主不明,只报告不强制(不误杀)。' -ForegroundColor Yellow
    if ($desktopShutdownRequested -and $desktopPort -gt 0) {
      Write-Host '优雅停机已请求但实例未下线,按端口属主兜底清理(仅限归属确认)...'
      Stop-PortOwners $desktopPort '桌面版服务'
    }
  }
  default {
    Write-Host "桌面版共享停机工具失败(退出码 $desktopServiceExit),请检查 Node 运行时: $desktopServiceTool" -ForegroundColor Red
    exit 1
  }
}
if (Test-Path $serviceFile) { Remove-Item $serviceFile -Force -ErrorAction SilentlyContinue }

# ── 固定端口(默认 3000):网页版/独立服务优雅停机 + 强制清理 ──
$fixedPids = @(Get-ListenerPids $Port)
if ($fixedPids.Count -gt 0) {
  $ownedFixedPids = @($fixedPids | Where-Object { Test-ProjectProcess $_ })
  if ($ownedFixedPids.Count -gt 0) {
    try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/shutdown" -TimeoutSec 5 | Out-Null } catch {}
    if (Wait-PortReleased $Port 20) {
      Write-Host "端口 $Port 的服务已停止。"
    } else {
      # 超时:强杀前重新做归属校验(fail-closed,防 PID 复用),仅杀归属确认的进程树。
      foreach ($ownerPid in $ownedFixedPids) {
        if (Test-ProjectProcess $ownerPid) {
          Write-Host "强制结束工作台进程 PID: $ownerPid"
          & $nodeExe $processTreeTool kill-tree $ownerPid 2>$null | Out-Null
          if ($LASTEXITCODE -ne 0) {
            Write-Host "强制结束失败(退出码 $LASTEXITCODE): $ownerPid" -ForegroundColor Red
          }
        } else {
          Write-Host "端口 $Port 的进程(PID $ownerPid)已不属于本项目,跳过(不误杀)。" -ForegroundColor Yellow
        }
      }
    }
  } else {
    Write-Host "端口 $Port 被非本项目进程占用,跳过(不误杀)。" -ForegroundColor Yellow
  }
}

# ── 进程特征兜底:状态文件丢失时,清掉仍挂在项目目录下的桌面壳/服务/dev 残留 ──
$appMarkers = '(server-entry\.js|standalone[\\/]server\.js|electron[\\/]cli\.js|next[\\/]dist[\\/]bin[\\/]next)'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'electron.exe' } |
  Where-Object {
    $exe = [string]$_.ExecutablePath
    $cmd = [string]$_.CommandLine
    (($_.Name -eq 'electron.exe') -and $exe -and $exe.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) -or
    ($cmd -and $cmd.IndexOf($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $cmd -match $appMarkers)
  } |
  ForEach-Object {
    Write-Host "清理残留进程 PID: $($_.ProcessId) ($($_.Name))"
    & $nodeExe $processTreeTool kill-tree $_.ProcessId 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "强制结束失败(退出码 $LASTEXITCODE): $($_.ProcessId)" -ForegroundColor Red
    }
  }

# ── 联动关闭 LiteLLM 代理(若曾由启动脚本拉起,或端口仍被占用)──
Write-Host '[2/2] 停止 LiteLLM 代理...'
$proxyBusy = @(& $nodeExe $portsTool listeners 4000)
if ($LASTEXITCODE -ne 0) {
  Write-Host "端口探测失败(退出码 $LASTEXITCODE): $portsTool" -ForegroundColor Red
  exit 1
}
if ((Test-Path $stackFile) -or $proxyBusy.Count -gt 0) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
} else {
  Write-Host 'LiteLLM 代理未在运行。'
}
