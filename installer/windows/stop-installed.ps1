param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Executable = Join-Path $Root 'CreativeStudio.exe'
$ResolvedExecutable = [System.IO.Path]::GetFullPath($Executable)

Write-Host '正在停止产品素材工作台…'
$processes = @(Get-CimInstance Win32_Process -Filter "Name='CreativeStudio.exe'" -ErrorAction SilentlyContinue)
$matched = $false
foreach ($process in $processes) {
  $processExecutable = $null
  if ($process.ExecutablePath) {
    try { $processExecutable = [System.IO.Path]::GetFullPath([string]$process.ExecutablePath) } catch { $processExecutable = $null }
  }
  if ($processExecutable -and $processExecutable -ieq $ResolvedExecutable) {
    $matched = $true
    & taskkill.exe /PID ([string]$process.ProcessId) /T /F | Out-Null
  }
}

if ($matched) {
  Write-Host '产品素材工作台及其私有服务进程树已停止。' -ForegroundColor Green
} else {
  Write-Host '未找到当前安装目录对应的运行实例。' -ForegroundColor Yellow
}
