#Requires -Version 5.1
<#
.SYNOPSIS
  只读验收 python-runtime/：Python 版本、LiteLLM 版本、run_server 导入、
  runtime-manifest.json 可解析且 wheel 哈希清单抽查、VC++ 私副本与许可证齐备。
.DESCRIPTION
  不修改任何文件、不联网、不读取任何密钥配置文件，不打印任何密钥。
  任一项失败以非零退出码结束。
#>
[CmdletBinding()]
param(
  # PS 5.1 的 param 默认值里 $PSScriptRoot 尚未就绪，必须在脚本体内解析默认路径
  [string]$RuntimeDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 本脚本承诺不联网：固定 LiteLLM 使用本地 model cost map，
# 否则 from litellm import run_server 会请求 GitHub 上的远程价格表，
# 在内网/受限网络下超时会向 stderr 写 WARNING（PS 5.1 + Stop 下等同于失败）。
$env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'

if (-not $RuntimeDir) { $RuntimeDir = Join-Path $PSScriptRoot '..\python-runtime' }

$script:failures = 0
function Check([bool]$Ok, [string]$Label) {
  if ($Ok) {
    Write-Host "[verify-python-runtime] PASS $Label"
  } else {
    Write-Host "[verify-python-runtime] FAIL $Label" -ForegroundColor Red
    $script:failures++
  }
}

if (-not (Test-Path $RuntimeDir)) {
  Write-Host "[verify-python-runtime] FAIL runtime 目录不存在：$RuntimeDir" -ForegroundColor Red
  exit 1
}
$runtime = (Resolve-Path $RuntimeDir).Path
$pythonExe = Join-Path $runtime 'python.exe'
Check (Test-Path $pythonExe) 'python.exe 存在'
if (-not (Test-Path $pythonExe)) { exit 1 }

# ── runtime-manifest.json 可解析且字段齐备，不含绝对路径或机器用户名 ──
$manifestPath = Join-Path $runtime 'runtime-manifest.json'
Check (Test-Path $manifestPath) 'runtime-manifest.json 存在'
$manifest = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json
Check ($manifest.schemaVersion -eq 1) 'manifest schemaVersion == 1'
foreach ($field in @('pythonVersion', 'targetTriple', 'archiveSha256', 'litellmVersion', 'dependencyLockSha256', 'buildScriptVersion', 'builtAt', 'wheels')) {
  Check ($null -ne $manifest.$field) "manifest 字段 $field 存在"
}
Check ($manifest.targetTriple -eq 'x86_64-pc-windows-msvc') 'manifest 平台为 Windows x64'
Check ($manifest.archiveSha256 -match '^[0-9a-f]{64}$') 'manifest archiveSha256 格式'
Check ($manifest.dependencyLockSha256 -match '^[0-9a-f]{64}$') 'manifest dependencyLockSha256 格式'
$manifestRaw = Get-Content -Raw -Encoding UTF8 $manifestPath
Check (($manifestRaw -notmatch '[A-Za-z]:\\') -and ($manifestRaw -notmatch [regex]::Escape($env:USERNAME))) 'manifest 不含绝对路径或机器用户名'

# ── 实际版本与 manifest 一致 ──
$pyVersionOut = (& $pythonExe --version 2>&1) -join ' '
Check ($pyVersionOut -eq "Python $($manifest.pythonVersion)") "Python 版本：$pyVersionOut"
$litellmVersion = ((& $pythonExe -c "from importlib.metadata import version; print(version('litellm'))") -join '').Trim()
Check ($litellmVersion -eq $manifest.litellmVersion) "LiteLLM 版本：$litellmVersion"
& $pythonExe -c "from litellm import run_server" 2>&1 | Out-Null
Check ($LASTEXITCODE -eq 0) 'from litellm import run_server'

# ── wheel 哈希清单抽查：条目格式合法，且对应发行包已按锁定版本安装 ──
$wheels = @($manifest.wheels)
Check ($wheels.Count -gt 50) "wheel 哈希清单条数：$($wheels.Count)"
$sampleSize = [Math]::Min(5, $wheels.Count)
$sample = $wheels | Get-Random -Count $sampleSize
foreach ($wheel in $sample) {
  Check (($wheel.file -match '^[A-Za-z0-9_.+]+-[^-]+-.*\.whl$') -and ($wheel.sha256 -match '^[0-9a-f]{64}$')) "wheel 条目格式：$($wheel.file)"
  $parts = $wheel.file -split '-'
  $distName = $parts[0] -replace '_', '-'
  $distVersion = $parts[1]
  $installedVersion = ''
  try {
    $installedVersion = ((& $pythonExe -c "import importlib.metadata as m, sys; print(m.version(sys.argv[1]))" $distName) -join '').Trim()
  } catch {}
  Check ($installedVersion -eq $distVersion) "wheel $($wheel.file) 对应发行包已安装（$installedVersion）"
}

# ── VC++ Runtime 私副本与第三方许可证 ──
Check ($manifest.vcRuntime.'vcruntime140.dll' -eq $true) 'manifest 记录 vcruntime140.dll 私副本'
Check ((Test-Path (Join-Path $runtime 'licenses')) -or (Test-Path (Join-Path $runtime 'LICENSE.txt'))) 'python-build-standalone 自带许可证已保留'
Check (Test-Path (Join-Path $runtime 'THIRD-PARTY-LICENSES')) 'THIRD-PARTY-LICENSES\ 存在'

if ($script:failures -gt 0) {
  Write-Host "[verify-python-runtime] $script:failures 项失败" -ForegroundColor Red
  exit 1
}
Write-Host '[verify-python-runtime] 全部通过'
exit 0
