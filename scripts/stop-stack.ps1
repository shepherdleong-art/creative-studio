# 一键停止：关闭 Creative Studio app、litellm 代理
# 端口探测/进程归属/stack.json 状态管理统一委托 scripts/runtime/*.mjs 共享工具。
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = Split-Path -Parent $PSScriptRoot

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
$portsTool = Join-Path $Root 'scripts\runtime\ports.mjs'
$stackStateTool = Join-Path $Root 'scripts\runtime\stack-state.mjs'
$processTreeTool = Join-Path $Root 'scripts\runtime\process-tree.mjs'

$stackRaw = (& $nodeExe $stackStateTool read $Root) -join "`n"
if ($LASTEXITCODE -ne 0) {
  Write-Host "状态文件读取失败(退出码 $LASTEXITCODE): $stackStateTool" -ForegroundColor Red
  exit 1
}
$stack = $null
if ($stackRaw -and $stackRaw.Trim() -ne 'null') {
  try { $stack = $stackRaw | ConvertFrom-Json } catch {}
}
$appPort = if ($stack.appPort) { [int]$stack.appPort } else { 3000 }
$proxyPort = if ($stack.proxyPort) { [int]$stack.proxyPort } else { 4000 }

function Get-ListenerPids([int]$TargetPort) {
  # 端口探测委托 ports.mjs;非零退出(工具不可用/参数错误)必须显式报错,不得静默继续。
  $lines = @(& $nodeExe $portsTool listeners $TargetPort)
  if ($LASTEXITCODE -ne 0) {
    Write-Host "端口探测失败(退出码 $LASTEXITCODE): $portsTool" -ForegroundColor Red
    exit 1
  }
  @($lines | ForEach-Object { if ($_ -match '^\s*(\d+)\s*$') { [int]$Matches[1] } } | Where-Object { $_ -gt 0 })
}

function Test-OwnedProcess([int]$TargetPid) {
  # 归属校验委托 process-tree.mjs(可执行路径/工作目录/命令行归属本项目目录才允许停止);
  # 退出码 1=不属于/已不存在(语义性,返回 false),其余=工具失败必须显式报错。
  & $nodeExe $processTreeTool check-owner $TargetPid $Root 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { return $true }
  if ($LASTEXITCODE -eq 1) { return $false }
  Write-Host "进程归属校验失败(退出码 $LASTEXITCODE): $processTreeTool" -ForegroundColor Red
  exit 1
}

function Stop-OwnedProcessTree([int]$TargetPid) {
  if (-not (Test-OwnedProcess $TargetPid)) { return $false }
  # 强杀整棵进程树委托 process-tree.mjs(等价 taskkill /T /F);失败显式报错不静默。
  & $nodeExe $processTreeTool kill-tree $TargetPid 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "强制结束失败(退出码 $LASTEXITCODE): $TargetPid" -ForegroundColor Red
  }
  return $true
}

# ── 1. app：状态文件 PID 归属当前根目录时才请求优雅停机，再强杀该进程树 ──
Write-Host '[1/2] 停止 Creative Studio...'
$appStopped = $false
if ($stack -and $stack.appCmdPid) {
  $appCmdPid = [int]$stack.appCmdPid
  if (Test-OwnedProcess $appCmdPid) {
    try {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$appPort/api/shutdown" -TimeoutSec 5 | Out-Null
      Start-Sleep -Seconds 2
    } catch {}
    if (Get-Process -Id $appCmdPid -ErrorAction SilentlyContinue) {
      & $nodeExe $processTreeTool kill-tree $appCmdPid 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Host "强制结束失败(退出码 $LASTEXITCODE): $appCmdPid" -ForegroundColor Red
      }
    }
    $appStopped = $true
  } elseif (Get-Process -Id $appCmdPid -ErrorAction SilentlyContinue) {
    Write-Host "状态文件中的 app PID $appCmdPid 不属于本项目，跳过（不误杀未知进程）。" -ForegroundColor Yellow
  }
}
if (-not $appStopped) {
  foreach ($ownerPid in (Get-ListenerPids $appPort)) {
    if (Test-OwnedProcess $ownerPid) {
      & $nodeExe $processTreeTool kill-tree $ownerPid 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Host "强制结束失败(退出码 $LASTEXITCODE): $ownerPid" -ForegroundColor Red
      }
      $appStopped = $true
    } else {
      Write-Host "端口 $appPort 的占用进程（PID $ownerPid）不属于本项目，未停止。" -ForegroundColor Yellow
    }
  }
}

# ── 2. litellm 代理：优先按状态文件 PID 停止，并校验进程归属本项目运行时 ──
# 不得仅凭端口杀死未知进程：只有归属校验通过(资源位于本项目目录内)的进程才允许停止，
# 其余一律跳过并明示。归属语义由共享 process-tree.mjs 统一实现(可执行路径/工作目录/命令行)。
Write-Host '[2/2] 停止 litellm 代理...'
$litellmStopped = $false
if ($stack -and $stack.litellmPid) {
  $litellmPid = [int]$stack.litellmPid
  if (Get-Process -Id $litellmPid -ErrorAction SilentlyContinue) {
    if (Stop-OwnedProcessTree $litellmPid) {
      $litellmStopped = $true
    } else {
      Write-Host "状态文件中的 PID $litellmPid 不属于本项目运行时，跳过（不误杀未知进程）。" -ForegroundColor Yellow
    }
  }
}
if (-not $litellmStopped) {
  # 兜底：端口属主中只停止归属本项目的进程，其余不动。
  foreach ($ownerPid in (Get-ListenerPids $proxyPort)) {
    if (Test-OwnedProcess $ownerPid) {
      & $nodeExe $processTreeTool kill-tree $ownerPid 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Host "强制结束失败(退出码 $LASTEXITCODE): $ownerPid" -ForegroundColor Red
      }
      $litellmStopped = $true
    } else {
      Write-Host "端口 $proxyPort 的占用进程（PID $ownerPid）不属于本项目运行时，未停止。" -ForegroundColor Yellow
    }
  }
}

& $nodeExe $stackStateTool clear $Root
if ($LASTEXITCODE -ne 0) {
  Write-Host "状态文件清理失败(退出码 $LASTEXITCODE): $stackStateTool" -ForegroundColor Red
}
Write-Host '已全部停止。'
