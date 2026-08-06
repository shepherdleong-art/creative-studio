# 一键组装公司网关 LiteLLM 私有运行时（离线 wheel + 固定版本，无需安装 Python）
# 产物在 .litellm-runtime\，与 .venv-litellm 并列被 start-windows.ps1 / start-stack.ps1 自动识别。
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$builder = Join-Path $ScriptDir 'build-litellm-sidecar.ps1'
if (-not (Test-Path -LiteralPath $builder)) { throw "缺少 LiteLLM 运行时构建脚本: $builder" }

Write-Host '组装公司网关 LiteLLM 私有运行时（固定 CPython 3.12.10 + LiteLLM 1.89.2）...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $builder `
  -CacheRoot (Join-Path $Root '.cache\windows-installer\litellm') `
  -OutputRoot (Join-Path $Root '.litellm-runtime')
if ($LASTEXITCODE -ne 0) {
  Write-Host "公司网关运行时组装失败（exit $LASTEXITCODE）。" -ForegroundColor Red
  exit $LASTEXITCODE
}
Write-Host '公司网关运行时就绪：.litellm-runtime' -ForegroundColor Green
Write-Host '导入统一配置（.provision）生成 config.yaml 后，start-windows.cmd 会自动拉起代理。'
