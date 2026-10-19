param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$DataRoot = if ($env:CREATIVE_STUDIO_DATA_ROOT) {
  [System.IO.Path]::GetFullPath($env:CREATIVE_STUDIO_DATA_ROOT)
} elseif ($env:APPDATA) {
  Join-Path $env:APPDATA 'CreativeStudio'
} else {
  throw '无法解析 CreativeStudio 用户数据目录。'
}
$Targets = @(
  (Join-Path $DataRoot 'data'),
  (Join-Path $DataRoot 'storage')
)

Write-Host '这会永久删除产品素材工作台的本地数据：'
foreach ($target in $Targets) {
  Write-Host "  $target"
}
Write-Host ''

if (-not $Force) {
  $answer = Read-Host '输入 DELETE 继续'
  if ($answer -ne 'DELETE') {
    Write-Host '已取消。'
    exit 0
  }
}

$stopScript = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'stop-installed.ps1'
if (Test-Path $stopScript) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript
}

foreach ($target in $Targets) {
  if (Test-Path $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "已删除：$target" -ForegroundColor Green
  }
}

Write-Host '产品素材工作台本地数据已删除。'
