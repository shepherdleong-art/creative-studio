# 桌面版（Electron）一键启动脚本，供 start-windows.cmd 调用。
# 与 start-windows.ps1（网页版）的区别：
#   - 这里启动的是 Electron 桌面壳 + 私有 Node 服务跑 production standalone 构建，
#     不是 dev server；服务监听 127.0.0.1 的随机端口，不占用 3000。
#   - 源码态运行时数据根仍是本项目目录（data/、storage/），与网页版共用同一个数据库。
# 停止：在应用菜单选择「退出」，或关闭本窗口。本机服务不得暴露到公网。
param(
  # 强制重新执行 npm run build（代码更新后使用）
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
Set-Location $Root

Write-Host '========================================'
Write-Host '  批量图片编辑工作台 - Windows 桌面版'
Write-Host '========================================'
Write-Host ''

# 免安装包内置便携 Node（node-runtime\node.exe，v22.22.3 / ABI 127），与包内
# 预编译原生模块（better-sqlite3）绑定；存在则优先使用，本机无需安装 Node。
$bundledNode = Join-Path $Root 'node-runtime\node.exe'
if (Test-Path $bundledNode) {
  $nodeExe = $bundledNode
  Write-Host "使用包内 Node 运行时: $(& $nodeExe --version)"
} else {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host '未找到 Node.js，包内也没有 node-runtime\node.exe。请安装 Node.js 22.x 或重新完整拷贝免安装包。' -ForegroundColor Red
    exit 1
  }
  $nodeExe = $node.Source
}

# 显式锁定私有 Node 服务使用的运行时，双击启动环境的 PATH 未必与开发终端一致。
$env:CREATIVE_STUDIO_NODE = $nodeExe

# 预编译原生模块（better-sqlite3）与 Node 大版本绑定，先用选定的 Node 试加载，
# 避免 Node 24 之类的版本错配到服务启动后才炸。
if (Test-Path (Join-Path $Root 'node_modules\better-sqlite3')) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $nodeExe -e "require('better-sqlite3')" *> $null
  $nativeOk = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prevEap
  if (-not $nativeOk) {
    Write-Host '当前 Node 运行时无法加载包内预编译的 better-sqlite3（免安装包按 Node 22 编译）。' -ForegroundColor Red
    Write-Host '请安装 Node.js 22.x，或使用含 node-runtime\node.exe 的完整免安装包。' -ForegroundColor Red
    exit 1
  }
}

# 需要 npm 的步骤（装依赖/构建）只在免安装包内容缺失时触发；npm 不存在时给出明确指引。
function Assert-NpmAvailable {
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Host '需要执行 npm，但本机未安装 Node.js。免安装包应自带依赖与构建产物，请重新完整拷贝。' -ForegroundColor Red
    exit 1
  }
}

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Assert-NpmAvailable
  Write-Host '首次运行，正在安装依赖，请保持联网...'
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) {
    Write-Host '依赖安装失败。请检查网络、npm registry 或杀毒软件拦截。' -ForegroundColor Red
    exit $LASTEXITCODE
  }
  Write-Host ''
}

# Electron 运行时二进制不随 npm 包元数据安装，缺失时显式补装后硬断言。
$electronBinary = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronBinary)) {
  Write-Host '正在安装 Electron 运行时...'
  $electronInstall = Join-Path $Root 'node_modules\electron\install.js'
  if (-not (Test-Path $electronInstall)) {
    Write-Host '缺少 electron 依赖，请先运行 npm ci。' -ForegroundColor Red
    exit 1
  }
  & $nodeExe $electronInstall
  if (-not (Test-Path $electronBinary)) {
    Write-Host "Electron 运行时安装失败：$electronBinary" -ForegroundColor Red
    exit 1
  }
  Write-Host ''
}

# 桌面版和网页版共用 data/workbench.db；同时运行会有并发写入风险。
$webListener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($webListener) {
  Write-Host '检测到 3000 端口已被占用，网页版可能正在运行。' -ForegroundColor Yellow
  Write-Host '桌面版与网页版共用 data/workbench.db，同时运行有并发写入风险。'
  $reply = Read-Host '仍要继续启动桌面版？(y/N)'
  if ($reply -notmatch '^(y|Y)$') { exit 1 }
  Write-Host ''
}

# venv 不可移植（pyvenv.cfg 写死创建机路径）：整个文件夹被拷贝到新机器后
# litellm.exe 可能已失效。先探测，坏了就用本机 Python 3.12 自动重建。
# 注意脚本全局 $ErrorActionPreference='Stop'，原生命令的 stderr 输出会变成
# 致命错误，调用前必须局部降为 Continue。
function Test-LitellmUsable {
  param([string]$Exe)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe --version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $prev
  }
}

$litellmExe = Join-Path $Root '.venv-litellm\Scripts\litellm.exe'
if ((Test-Path $litellmExe) -and -not (Test-LitellmUsable $litellmExe)) {
  Write-Host '检测到 LiteLLM 环境已失效（venv 是从其他机器拷贝的），尝试自动重建...' -ForegroundColor Yellow
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & py -3.12 --version *> $null
    $pyOk = $LASTEXITCODE -eq 0
    if (-not $pyOk) {
      # 保留损坏的 venv：这样下次启动（装了 Python 之后）还会走自动重建。
      Write-Host '未找到 Python 3.12，无法自动重建。公司供应商将不可用；安装 Python 3.12 后重开本脚本即可自动修复。' -ForegroundColor Yellow
    } else {
      # 重建前先停掉可能正在运行的受控 sidecar（运行中的 exe 删不掉）。
      if (Test-Path (Join-Path $Root 'storage\run\stack.json')) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
      }
      # 兜底：stack.json 缺失/失效时仍可能有残留进程占用 venv 文件，按路径清理。
      $venvPrefix = (Join-Path $Root '.venv-litellm') + '\'
      Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='litellm.exe'" |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($venvPrefix, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 1
      try {
        Remove-Item (Join-Path $Root '.venv-litellm') -Recurse -Force -ErrorAction Stop
      } catch {
        Write-Host "无法删除旧的 .venv-litellm（仍有进程占用），请关闭相关程序后重开本脚本。公司供应商暂不可用。" -ForegroundColor Yellow
        Write-Host ''
        # 跳过重建，继续启动工作台
        $pyOk = $false
      }
      if ($pyOk) {
        & py -3.12 -m venv .venv-litellm
        & (Join-Path $Root '.venv-litellm\Scripts\python.exe') -m pip install -r requirements-litellm.txt
        if (-not (Test-LitellmUsable $litellmExe)) {
          Write-Host 'LiteLLM 环境重建失败，公司供应商将不可用；工作台其他功能不受影响。' -ForegroundColor Yellow
          Remove-Item (Join-Path $Root '.venv-litellm') -Recurse -Force -ErrorAction SilentlyContinue
        } else {
          Write-Host 'LiteLLM 环境重建完成。'
        }
      }
    }
  } finally {
    $ErrorActionPreference = $prevEap
  }
  Write-Host ''
}

# 公司供应商运行环境是可选 sidecar；失败只禁用公司供应商，不阻塞工作台。
$stackStarted = $false
$hasStackComponents = (Test-Path (Join-Path $Root '.venv-litellm\Scripts\litellm.exe')) -and
                      (Test-Path (Join-Path $Root 'config.yaml'))
if ($hasStackComponents) {
  Write-Host '检测到公司网关组件，启动 litellm 代理...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'start-stack.ps1') -SkipApp
  if ($LASTEXITCODE -ne 0) {
    Write-Host '公司网关组件启动失败，继续启动工作台。' -ForegroundColor Yellow
  } elseif (Test-Path (Join-Path $Root 'storage\run\stack.json')) {
    $stackStarted = $true
    Write-Host '公司网关代理就绪: http://127.0.0.1:4000'
  } else {
    Write-Host '公司网关状态文件缺失，正在清理 sidecar 并继续启动工作台。' -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
  }
  Write-Host ''
}

# 桌面壳要求 production standalone 产物存在，dev server 的产物不适用。
$standaloneServer = Join-Path $Root '.next\standalone\server.js'
$standaloneEntry = Join-Path $Root '.next\standalone\runtime\server-entry.js'
if ($Rebuild -or -not (Test-Path $standaloneServer) -or -not (Test-Path $standaloneEntry)) {
  Assert-NpmAvailable
  if ($Rebuild) {
    Write-Host '正在重新构建工作台（-Rebuild）...'
  } else {
    Write-Host '未找到 standalone 构建产物，正在首次构建（需要几分钟）...'
  }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host '构建失败，请查看上方错误输出。' -ForegroundColor Red
    exit $LASTEXITCODE
  }
  Write-Host ''
} else {
  Write-Host "使用已有构建产物：.next\standalone\server.js（代码有更新时请运行 start-windows.cmd -Rebuild）"
  Write-Host ''
}

# 桌面壳源码没变化时跳过 tsc 编译（每次白等约 10 秒）
$desktopBuiltEntry = Join-Path $Root 'dist-desktop\main.js'
$desktopNeedsBuild = $true
if (Test-Path $desktopBuiltEntry) {
  $builtAt = (Get-Item $desktopBuiltEntry).LastWriteTime
  $newestSource = Get-ChildItem (Join-Path $Root 'desktop') -Filter '*.ts' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $desktopNeedsBuild = (-not $newestSource) -or ($newestSource.LastWriteTime -gt $builtAt)
}
if ($desktopNeedsBuild) {
  Assert-NpmAvailable
  Write-Host '正在编译桌面壳...'
  & npm.cmd run build:desktop
  if ($LASTEXITCODE -ne 0) {
    Write-Host '桌面壳编译失败，请查看上方错误输出。' -ForegroundColor Red
    exit $LASTEXITCODE
  }
  Write-Host ''
} else {
  Write-Host '桌面壳源码无变化，跳过编译。'
  Write-Host ''
}

Write-Host '正在启动桌面版...'
Write-Host ''
Write-Host '使用说明:'
Write-Host '  1. 服务只监听 127.0.0.1 的随机端口，不会暴露到公网'
Write-Host '  2. 关闭窗口只是隐藏，请从应用菜单选择「退出」结束后台任务'
Write-Host '  3. 直接关闭此窗口也会触发桌面版优雅退出'
Write-Host ''

# 桌面壳退出时会请求 /api/shutdown，那条链路已经会停掉受控的 LiteLLM；
# 这里的 finally 只是异常退出时的兜底，stop-stack.ps1 本身幂等。
try {
  & (Join-Path $Root 'node_modules\.bin\electron.cmd') .
  $desktopExitCode = $LASTEXITCODE
} finally {
  if ($stackStarted) {
    Write-Host ''
    Write-Host '正在关闭 litellm 代理...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
  }
}
exit $desktopExitCode
