param(
  [string]$OldRoot,
  [string]$NewRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageRoot = Split-Path -Parent $ScriptDir
if (-not $NewRoot) { $NewRoot = $PackageRoot }

function Resolve-Directory([string]$Value) {
  $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Value)
  return [System.IO.Path]::GetFullPath($resolved).TrimEnd('\')
}

function Get-OwnedProcesses([string]$OwnedRoot) {
  $OwnedPrefix = $OwnedRoot.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('node.exe', 'electron.exe', 'python.exe', 'litellm.exe') } |
    Where-Object {
      $exe = [string]$_.ExecutablePath
      $cmd = [string]$_.CommandLine
      ($exe -and $exe.StartsWith($OwnedPrefix, [StringComparison]::OrdinalIgnoreCase)) -or
      ($cmd -and $cmd.IndexOf($OwnedPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
}

function Stop-OwnedProcessTrees([string]$OwnedRoot, [string]$Label) {
  $owned = @(Get-OwnedProcesses $OwnedRoot)
  foreach ($process in ($owned | Sort-Object ProcessId -Descending)) {
    Write-Host "强制结束${Label}残留进程树 PID: $($process.ProcessId) ($($process.Name))"
    & taskkill.exe /PID ([string]$process.ProcessId) /T /F 2>$null | Out-Null
  }
  if ($owned.Count -gt 0) { Start-Sleep -Milliseconds 800 }
  $remaining = @(Get-OwnedProcesses $OwnedRoot)
  if ($remaining.Count -gt 0) {
    throw "仍有${Label}进程未能停止（PID: $($remaining.ProcessId -join ', ')）。请关闭相关窗口或在任务管理器结束后重试。"
  }
}

try {
  $NewRoot = Resolve-Directory $NewRoot
  $PackageRoot = Resolve-Directory $PackageRoot
  if (-not $NewRoot.Equals($PackageRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '迁移目标必须是本脚本所在的 0.6.0 免安装版目录。'
  }

  if (-not $OldRoot) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '请选择旧版免安装版的根目录（里面应有 data、storage、start-windows.cmd）'
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
      Write-Host '已取消迁移。'
      exit 2
    }
    $OldRoot = $dialog.SelectedPath
  }
  $OldRoot = Resolve-Directory $OldRoot

  if (-not (Test-Path -LiteralPath (Join-Path $OldRoot 'data\workbench.db') -PathType Leaf)) {
    throw '所选目录中没有 data\workbench.db，请选择旧版免安装版的根目录。'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $OldRoot 'start-windows.cmd') -PathType Leaf)) {
    throw '所选目录缺少 start-windows.cmd，不像旧版免安装版根目录。'
  }
  if ($OldRoot.Equals($NewRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '旧版目录和新版目录不能相同。'
  }

  Write-Host '========================================'
  Write-Host '  Creative Studio 旧版数据迁移到 0.6.0'
  Write-Host '========================================'
  Write-Host "旧版目录：$OldRoot"
  Write-Host "新版目录：$NewRoot"
  Write-Host ''
  Write-Host '[1/3] 停止新版工作台与公司网关...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-windows.ps1')
  Stop-OwnedProcessTrees $NewRoot '新版'

  Write-Host '[2/3] 停止旧版目录的残留进程...'
  Stop-OwnedProcessTrees $OldRoot '旧版'

  $nodeExe = Join-Path $NewRoot 'node-runtime\node.exe'
  $migrationScript = Join-Path $ScriptDir 'migrate-portable-data.mjs'
  if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    throw '免安装包缺少 node-runtime\node.exe，请重新完整复制 0.6.0 免安装包。'
  }
  if (-not (Test-Path -LiteralPath $migrationScript -PathType Leaf)) {
    throw '免安装包缺少 scripts\migrate-portable-data.mjs，请重新完整复制 0.6.0 免安装包。'
  }

  Write-Host '[3/3] 备份数据库、复制业务素材并修复媒体路径...'
  & $nodeExe $migrationScript --old-root $OldRoot --new-root $NewRoot
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host ''
  Write-Host '迁移验收通过。现在可以双击 start-windows.cmd 启动 0.6.0。' -ForegroundColor Green
  exit 0
} catch {
  Write-Host ''
  Write-Host "迁移失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '旧版目录不会被修改；请按提示处理后重试。'
  exit 1
}
