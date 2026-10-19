#Requires -Version 5.1
<#
.SYNOPSIS
  构建 Windows x64 便携 Python 运行时（python-runtime/）。维护者专用，终端用户不运行。
.DESCRIPTION
  严格按 docs/2026-08-14-脚本生成进度保持与内置python运行时-梳理.md §B3 执行：
  锁文件交叉校验 → 下载归档（SHA-256 核验，不匹配即删缓存）→ 独立 staging 解压 →
  pip download --only-binary=:all: 到临时 wheelhouse（逐 wheel 记录 SHA-256）→
  pip install --no-index --find-links 离线安装 → 版本验证三件套 →
  临时最小配置实测启动 LiteLLM（清代理/包索引环境）→ VC++ 私副本检查 →
  runtime-manifest.json + 第三方许可证汇总 → 原子发布（改名备份/改名 staging/失败回滚）。
  完整性一律由 scripts/python-runtime-win-x64.lock.json 的 SHA-256 保证；
  PYTHON_RUNTIME_ARCHIVE_BASE 仅用于切换下载镜像（如南大镜像），不改变验收。
#>
[CmdletBinding()]
param(
  [string]$ArchiveBaseUrl = $env:PYTHON_RUNTIME_ARCHIVE_BASE
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  Write-Host "[build-python-runtime] FAILED: $Message" -ForegroundColor Red
  throw $Message
}
function Info([string]$Message) { Write-Host "[build-python-runtime] $Message" }

# ── 步骤 1：平台硬校验 ──
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Fail '本脚本只能在 Windows 上运行'
}
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  Fail "仅支持 Windows x64，当前 PROCESSOR_ARCHITECTURE=$env:PROCESSOR_ARCHITECTURE"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cacheDir = Join-Path $repoRoot '.cache\python-runtime'
$stagingRoot = Join-Path $cacheDir 'staging'
$extractDir = Join-Path $cacheDir 'extract'
$wheelhouse = Join-Path $cacheDir 'wheelhouse'
$smokeDir = Join-Path $cacheDir 'smoke'
$stagingRuntime = Join-Path $stagingRoot 'python-runtime'
$finalDir = Join-Path $repoRoot 'python-runtime'

# ── 步骤 2：读取锁文件并交叉校验依赖锁哈希 ──
$lockPath = Join-Path $repoRoot 'scripts\python-runtime-win-x64.lock.json'
if (-not (Test-Path $lockPath)) { Fail "缺少锁文件 scripts\python-runtime-win-x64.lock.json" }
$lock = Get-Content -Raw -Encoding UTF8 $lockPath | ConvertFrom-Json
$requirementsLockPath = Join-Path $repoRoot $lock.dependencyLockFile
if (-not (Test-Path $requirementsLockPath)) { Fail "缺少依赖锁 $($lock.dependencyLockFile)" }
$reqHash = (Get-FileHash -Algorithm SHA256 $requirementsLockPath).Hash.ToLowerInvariant()
if ($reqHash -ne $lock.dependencyLockSha256.ToLowerInvariant()) {
  Fail "依赖锁哈希与 lock JSON 不一致：lock 记录 $($lock.dependencyLockSha256)，实际 $reqHash"
}
Info "锁文件校验通过：Python $($lock.pythonVersion) / LiteLLM $($lock.litellmVersion)"
# pip 在中文 Windows 上按 PEP263/ANSI(GBK) 解码 requirements 文件，锁文件中的中文注释会触发
# UnicodeDecodeError；因此生成一份仅含 ASCII「name==version」行的等效清单供 pip 使用，
# 权威输入仍是上面已完成 SHA-256 交叉校验的原始锁文件。
$effectiveLockPath = Join-Path $cacheDir 'requirements-effective.txt'
$effectiveLines = @(Get-Content -Encoding UTF8 $requirementsLockPath | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
if ($effectiveLines.Count -lt 50) { Fail "依赖锁有效行数异常少（$($effectiveLines.Count)），导出可能不完整" }
foreach ($line in $effectiveLines) {
  if ($line -notmatch '^[A-Za-z0-9_.-]+==[0-9][A-Za-z0-9.!+]*$') { Fail "依赖锁存在非 name==精确版本 行：$line" }
}
Set-Content -Encoding ASCII $effectiveLockPath $effectiveLines

# ── 步骤 3：下载归档到 .cache\python-runtime\，SHA-256 不匹配即删缓存并失败 ──
$archiveName = "cpython-$($lock.pythonVersion)+$($lock.pythonBuildStandaloneRelease)-$($lock.targetTriple)-install_only_stripped.tar.gz"
if ($ArchiveBaseUrl) {
  $downloadUrl = $ArchiveBaseUrl.TrimEnd('/') + '/' + [System.Uri]::EscapeDataString($archiveName)
} else {
  $downloadUrl = $lock.archiveUrl
}
New-Item -ItemType Directory -Force $cacheDir | Out-Null
$archivePath = Join-Path $cacheDir $archiveName
$expectedSha = $lock.archiveSha256.ToLowerInvariant()
$needDownload = $true
if (Test-Path $archivePath) {
  if ((Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant() -eq $expectedSha) {
    Info '缓存归档哈希匹配，跳过重复下载'
    $needDownload = $false
  } else {
    Remove-Item -Force $archivePath
  }
}
if ($needDownload) {
  Info "下载归档：$downloadUrl"
  $curlExe = Join-Path $env:SystemRoot 'System32\curl.exe'
  try {
    if (Test-Path $curlExe) {
      & $curlExe -fSL --retry 3 -o $archivePath $downloadUrl
      if ($LASTEXITCODE -ne 0) { Fail "curl 下载失败（exit $LASTEXITCODE）" }
    } else {
      Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing
    }
  } catch {
    if (Test-Path $archivePath) { Remove-Item -Force $archivePath }
    Fail "归档下载失败：$($_.Exception.Message)"
  }
}
$actualSha = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
if ($actualSha -ne $expectedSha) {
  Remove-Item -Force $archivePath   # 哈希不匹配：立即删除本次缓存再失败
  Fail "归档 SHA-256 不匹配：期望 $expectedSha，实际 $actualSha（缓存已删除）"
}
Info '归档 SHA-256 核验通过'

# ── 步骤 4：独立 staging 解压并规范化结构，不触碰现有 python-runtime/ ──
foreach ($d in @($stagingRoot, $extractDir)) {
  if (Test-Path $d) { Remove-Item -Recurse -Force $d }
  New-Item -ItemType Directory -Force $d | Out-Null
}
Info '解压归档到独立 staging 目录'
# 必须显式用 Windows 自带 bsdtar：Git Bash 的 MSYS tar 会把 I:\ 的冒号误判为远程磁带机
$tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $tarExe)) { Fail "未找到 Windows 自带 tar：$tarExe" }
& $tarExe -xzf $archivePath -C $extractDir
if ($LASTEXITCODE -ne 0) { Fail "tar 解压失败（exit $LASTEXITCODE）" }
# install_only_stripped 归档顶层是 python/，把其内容规范化为最终 python-runtime/ 根结构
$innerPython = Join-Path $extractDir 'python'
if (-not (Test-Path (Join-Path $innerPython 'python.exe'))) {
  Fail '归档顶层缺少 python\python.exe，锁定基线无效，停止发布'
}
Move-Item $innerPython $stagingRuntime
Remove-Item -Recurse -Force $extractDir
$pythonExe = Join-Path $stagingRuntime 'python.exe'

# 硬断言 staging 解释器自带可运行 pip（PBS install_only 自带 pip）；
# 若不满足则判定锁定基线无效并停止，不得现场装 pip 或换系统 Python 补洞
& $pythonExe -m pip --version
if ($LASTEXITCODE -ne 0) { Fail 'staging 解释器不带可运行 pip，锁定基线无效，停止构建' }
Info 'staging 解释器与内置 pip 可用'

# ── 步骤 5：pip download 纯 wheel 到临时 wheelhouse，逐 wheel 记录 SHA-256 ──
if (Test-Path $wheelhouse) { Remove-Item -Recurse -Force $wheelhouse }
New-Item -ItemType Directory -Force $wheelhouse | Out-Null
Info 'pip download --only-binary=:all: 下载全部锁定依赖（任何源码包或缺 wheel 都会失败）'
& $pythonExe -m pip download --only-binary=:all: --dest $wheelhouse -r $effectiveLockPath
if ($LASTEXITCODE -ne 0) { Fail "pip download 失败（exit $LASTEXITCODE）：存在缺 wheel 或源码包" }
$nonWheel = @(Get-ChildItem $wheelhouse -File | Where-Object { $_.Extension -ne '.whl' })
if ($nonWheel.Count -gt 0) { Fail "wheelhouse 中出现非 wheel 文件：$(($nonWheel | ForEach-Object Name) -join ', ')" }
$wheelHashes = @(Get-ChildItem $wheelhouse -Filter *.whl | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{
    file = $_.Name
    sha256 = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()
  }
})
Info "wheelhouse 就绪：$($wheelHashes.Count) 个 wheel 已逐一记录 SHA-256"

# ── 步骤 6：离线安装（--no-index --find-links），证明安装不依赖网络与浮动解析 ──
Info 'pip install --no-index --find-links 离线安装完整锁文件'
& $pythonExe -m pip install --no-index --find-links $wheelhouse -r $effectiveLockPath
if ($LASTEXITCODE -ne 0) { Fail "离线安装失败（exit $LASTEXITCODE）" }

# ── 步骤 7：运行时入口只使用包内解释器加载 Python 模块，不调用 pip 生成的 exe 入口（固定走 start-litellm-proxy.py） ──

# ── 步骤 8：版本验证三件套（固定本地 model cost map，导入 litellm 不请求 GitHub 远程价格表）──
$env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'
$pyVersionOut = (& $pythonExe --version 2>&1) -join ' '
if ($pyVersionOut -ne "Python $($lock.pythonVersion)") { Fail "Python 版本不符：$pyVersionOut" }
& $pythonExe -c "from importlib.metadata import version; v = version('litellm'); assert v == '$($lock.litellmVersion)', v"
if ($LASTEXITCODE -ne 0) { Fail 'litellm 版本断言失败' }
& $pythonExe -c "from litellm import run_server; print('LiteLLM entrypoint OK')"
if ($LASTEXITCODE -ne 0) { Fail 'from litellm import run_server 失败' }
Info "版本验证通过：$pyVersionOut / litellm $($lock.litellmVersion)"

# ── 步骤 9/10：临时最小配置实测启动 LiteLLM（先清代理与包索引环境，证明运行不下载依赖）──
$entryScript = Join-Path $repoRoot 'scripts\start-litellm-proxy.py'
if (-not (Test-Path $entryScript)) { Fail '缺少 scripts\start-litellm-proxy.py' }
if (Test-Path $smokeDir) { Remove-Item -Recurse -Force $smokeDir }
New-Item -ItemType Directory -Force $smokeDir | Out-Null
$smokeConfig = Join-Path $smokeDir 'litellm-smoke.yaml'
# 假密钥，仅用于本地健康检查，不得替换为真实密钥
@'
model_list: []
general_settings:
  master_key: sk-build-smoke-not-a-real-key
'@ | Set-Content -Encoding UTF8 $smokeConfig

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$smokePort = $listener.LocalEndpoint.Port
$listener.Stop()

$clearedVars = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'UV_INDEX_URL')
$savedEnv = @{}
foreach ($name in $clearedVars) {
  $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$stdoutLog = Join-Path $smokeDir 'litellm-stdout.log'
$stderrLog = Join-Path $smokeDir 'litellm-stderr.log'
$proc = $null
try {
  $proc = Start-Process -FilePath $pythonExe `
    -ArgumentList @($entryScript, '--config', $smokeConfig, '--host', '127.0.0.1', '--port', "$smokePort") `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  $healthUrl = "http://127.0.0.1:$smokePort/health/liveliness"
  $deadline = (Get-Date).AddSeconds(240)
  $healthy = $false
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    try {
      $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
      if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $healthy) {
    $tail = if (Test-Path $stderrLog) { (Get-Content $stderrLog -Tail 20) -join "`n" } else { '' }
    Fail "LiteLLM 健康检查超时或进程提前退出（$healthUrl）。stderr 尾部：`n$tail"
  }
  Info "LiteLLM 实测启动健康检查通过：$healthUrl（PID $($proc.Id)，即将按 PID 受控停止）"
} finally {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
    [void]$proc.WaitForExit(30000)
  }
  foreach ($name in $clearedVars) {
    [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process')
  }
}

# ── VC++ Runtime 私副本检查：PBS 自带 vcruntime140 私副本；缺失即报告，不静默 ──
# 实测基线：PBS install_only_stripped 自带 vcruntime140.dll / vcruntime140_1.dll（硬要求）；
# msvcp140.dll 不随 PBS 分发——本锁定依赖闭包中 numpy 已在 numpy.libs\ 自带私有副本，
# 仅 pywin32 的 mapi/exchange 扩展引用它而 LiteLLM 链路不使用这些扩展，
# 因此 msvcp140 缺失只记录进 manifest 并给出响亮警告，不阻断发布。
$vcRequired = @('vcruntime140.dll', 'vcruntime140_1.dll')
$vcOptional = @('msvcp140.dll')
$vcStatus = [ordered]@{}
foreach ($dll in ($vcRequired + $vcOptional)) {
  $vcStatus[$dll] = (Test-Path (Join-Path $stagingRuntime $dll)) -or (Test-Path (Join-Path $stagingRuntime "DLLs\$dll"))
}
$vcMissing = @($vcRequired | Where-Object { -not $vcStatus[$_] })
if ($vcMissing.Count -gt 0) {
  Fail "PBS 未自带 VC++ Runtime 私副本：$($vcMissing -join ', ')。需按 Microsoft 允许的 app-local 方式补 DLL 并附许可证后重试，不得静默发布。"
}
$vcNote = 'vcruntime140.dll/vcruntime140_1.dll 随 PBS 自带'
foreach ($dll in $vcOptional) {
  if (-not $vcStatus[$dll]) {
    $vcNote += "；$dll 未随 PBS 分发（numpy.libs 自带私有副本，pywin32 mapi/exchange 扩展引用但 LiteLLM 不使用），干净机器验收需重点复核"
    Write-Host "[build-python-runtime] WARNING: $dll 未随 PBS 自带，已记录 manifest；若干净机器验收缺此 DLL，须按 app-local 方式补齐" -ForegroundColor Yellow
  }
}
Info "VC++ Runtime 检查完成：$vcNote"

# ── 步骤 11：写 runtime-manifest.json（版本/平台/依赖锁哈希/wheel 哈希清单/构建时间/构建脚本版本；
#    不记录机器用户名、绝对路径或密钥）──
$manifest = [ordered]@{
  schemaVersion = 1
  pythonVersion = $lock.pythonVersion
  pythonBuildStandaloneRelease = $lock.pythonBuildStandaloneRelease
  targetTriple = $lock.targetTriple
  archiveSha256 = $expectedSha
  litellmVersion = $lock.litellmVersion
  dependencyLockFile = $lock.dependencyLockFile
  dependencyLockSha256 = $lock.dependencyLockSha256
  buildScriptVersion = $lock.buildScriptVersion
  builtAt = (Get-Date).ToUniversalTime().ToString('o')
  wheelCount = $wheelHashes.Count
  wheels = $wheelHashes
  vcRuntime = $vcStatus
  vcRuntimeNote = $vcNote
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $stagingRuntime 'runtime-manifest.json')
Info 'runtime-manifest.json 已写入 staging'

# ── 步骤 12：第三方许可证汇总（PBS 自带许可证必须保留；包许可证从 importlib.metadata 汇总）──
$licenseDir = Join-Path $stagingRuntime 'THIRD-PARTY-LICENSES'
New-Item -ItemType Directory -Force $licenseDir | Out-Null
$pbsLicensesDir = Join-Path $stagingRuntime 'licenses'
$pbsLicenseTxt = Join-Path $stagingRuntime 'LICENSE.txt'
if ((Test-Path $pbsLicensesDir) -or (Test-Path $pbsLicenseTxt)) {
  Info 'python-build-standalone 自带许可证已保留在 runtime 内'
} else {
  Fail '未找到 python-build-standalone 自带许可证（licenses\ 或 LICENSE.txt），不得静默发布'
}
$collectScript = Join-Path $smokeDir 'collect-licenses.py'
@'
import importlib.metadata as md
import pathlib
import shutil
import sys

out = pathlib.Path(sys.argv[1])
count = 0
for dist in md.distributions():
    name = dist.metadata.get("Name") or "unknown"
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)
    target = out / safe
    wrote = False
    try:
        files = list(dist.files or [])
    except Exception:
        files = []
    for f in files:
        lowered = str(f).lower()
        if any(key in lowered for key in ("license", "licence", "copying", "notice")):
            src = pathlib.Path(dist.locate_file(f))
            if src.is_file() and src.stat().st_size < 2_000_000:
                target.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, target / pathlib.Path(str(f)).name)
                wrote = True
    if not wrote:
        text = dist.metadata.get("License-Expression") or dist.metadata.get("License")
        if text:
            target.mkdir(parents=True, exist_ok=True)
            (target / "LICENSE-METADATA.txt").write_text(text, encoding="utf-8")
            wrote = True
    if wrote:
        count += 1
print(f"collected license material for {count} distributions")
'@ | Set-Content -Encoding UTF8 $collectScript
& $pythonExe $collectScript $licenseDir
if ($LASTEXITCODE -ne 0) { Fail '第三方许可证汇总失败' }

# ── 步骤 13：原子发布——旧目录改名同盘备份 → staging 改名 python-runtime/ → 成功删备份；失败回滚 ──
$backupDir = Join-Path $repoRoot ('python-runtime.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$movedOld = $false
try {
  if (Test-Path $finalDir) {
    Move-Item $finalDir $backupDir
    $movedOld = $true
  }
  Move-Item $stagingRuntime $finalDir
} catch {
  # 回滚：绝不让机器停留在没有可用 runtime 的状态
  if ($movedOld -and -not (Test-Path $finalDir)) {
    Move-Item $backupDir $finalDir
  }
  Fail "原子发布失败，已回滚：$($_.Exception.Message)"
}
if ($movedOld) { Remove-Item -Recurse -Force $backupDir }

# 清理临时 wheelhouse / smoke / staging（wheel 哈希已入 manifest，成品不含 wheelhouse）
Remove-Item -Recurse -Force $wheelhouse
Remove-Item -Recurse -Force $smokeDir
if (Test-Path $stagingRoot) { Remove-Item -Recurse -Force $stagingRoot }
Info "构建完成：python-runtime\（Python $($lock.pythonVersion) / LiteLLM $($lock.litellmVersion)，$($wheelHashes.Count) wheels）"
