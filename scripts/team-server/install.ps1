#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$DeploymentId = '',
    [switch]$Apply
)
. (Join-Path $PSScriptRoot 'common.ps1')

function Assert-TeamAdministrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '安装 SCM 与防火墙需要管理员令牌'
    }
}

function Set-TeamFirewall {
    param([object]$Resolved)
    $displayName = 'CreativeStudio-' + [string]$Resolved.deploymentId + '-HTTPS'
    $existing = Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue
    $expectedRemote = @($Resolved.allowedNetworks | ForEach-Object { [string]$_ } | Sort-Object)
    if ($existing) {
        $port = $existing | Get-NetFirewallPortFilter
        $address = $existing | Get-NetFirewallAddressFilter
        $actualRemote = @($address.RemoteAddress | ForEach-Object { [string]$_ } | Sort-Object)
        if ($port.Protocol -ne 'TCP' -or [string]$port.LocalPort -ne [string]$Resolved.entryPort -or
            ($actualRemote -join '|') -ne ($expectedRemote -join '|') -or $existing.Direction -ne 'Inbound') {
            throw '同名防火墙规则不属于本部署合同，拒绝覆盖'
        }
        return
    }
    New-NetFirewallRule -DisplayName $displayName -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort ([int]$Resolved.entryPort) -RemoteAddress $expectedRemote `
        -Description ('Creative Studio ' + [string]$Resolved.deploymentId + ' HTTPS only; app/LiteLLM stay loopback') | Out-Null
}

function Ensure-TeamControlCredential {
    param([object]$Resolved)
    $path = [string]$Resolved.controlCredentialFile
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw '控制凭据不得是链接' }
        try {
            $existing = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch { throw '既有控制凭据无法解析，拒绝覆盖' }
        if ($existing.schemaVersion -ne 1 -or $existing.deploymentId -ne $Resolved.deploymentId -or
            -not ($existing.token -is [string]) -or $existing.token.Length -lt 32) {
            throw '既有控制凭据部署不匹配，拒绝覆盖'
        }
    } else {
        $bytes = New-Object byte[] 32
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        $value = [ordered]@{
            schemaVersion = 1
            deploymentId = [string]$Resolved.deploymentId
            token = [Convert]::ToBase64String($bytes)
        }
        $json = ConvertTo-Json -InputObject $value -Compress
        [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
    Grant-TeamAcl -Path $path -Account ([string]$Resolved.serviceAccount) -Permission 'R'
}

try {
    $resolved = Resolve-TeamDeployment -ConfigPath $ConfigPath -DeploymentId $DeploymentId
    if (-not $Apply) {
        Write-TeamOperationJson -Value ([ordered]@{
            schemaVersion = 1
            action = 'install'
            dryRun = $true
            applyPerformed = $false
            deploymentId = [string]$resolved.deploymentId
            releaseId = [string]$resolved.releaseId
            deploymentRoot = [string]$resolved.deploymentRoot
            dataRoot = [string]$resolved.dataRoot
            backupRoot = [string]$resolved.backupRoot
            services = @($resolved.services | ForEach-Object { $_.id })
            ports = @{ https = $resolved.entryPort; app = $resolved.appPort; litellm = $resolved.liteLLMPort }
        })
        exit 0
    }

    Assert-TeamAdministrator
    if (@($resolved.allowedNetworks).Count -eq 0) { throw 'apply 必须显式限定获准内网 CIDR' }
    foreach ($root in @($resolved.deploymentRoot, $resolved.dataRoot, $resolved.backupRoot, $resolved.releaseRoot)) {
        Assert-NoReparsePoint -Path ([string]$root)
    }
    foreach ($certificatePath in @($resolved.certificate.certPath, $resolved.certificate.keyPath)) {
        if (-not (Test-Path -LiteralPath ([string]$certificatePath) -PathType Leaf)) {
            throw '证书或私钥路径不存在；不会生成自签证书或改变信任'
        }
    }
    $marker = Join-Path ([string]$resolved.dataRoot) 'data\deployment.json'
    if ((Test-Path -LiteralPath ([string]$resolved.dataRoot) -PathType Container) -and -not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        if (@(Get-ChildItem -LiteralPath ([string]$resolved.dataRoot) -Force).Count -gt 0) {
            throw '数据根非空且没有本部署标识，拒绝初始化或覆盖'
        }
    } elseif (Test-Path -LiteralPath $marker -PathType Leaf) {
        $existingMarker = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($existingMarker.deploymentId -ne $resolved.deploymentId) { throw '数据根属于其他部署，拒绝覆盖' }
    }

    # Unknown names/PathName are rejected before any directory, credential, service or firewall change.
    $existingServices = @{}
    foreach ($service in $resolved.services) {
        $existingServices[[string]$service.id] = Assert-TeamServiceTarget -Service $service
    }

    $releaseManifest = Join-Path ([string]$resolved.releaseRoot) 'release-manifest.json'
    $probe = Join-Path ([string]$resolved.releaseRoot) 'service\probe-team-server.mjs'
    if (-not (Test-Path -LiteralPath $releaseManifest -PathType Leaf) -or -not (Test-Path -LiteralPath $probe -PathType Leaf)) {
        throw 'release 缺少受控 manifest 或原生负载探针'
    }
    $probeOutput = & ([string]$resolved.nodeExecutable) $probe --release ([string]$resolved.releaseRoot)
    if ($LASTEXITCODE -ne 0) { throw 'release 原生模块/媒体探针未通过，未安装服务' }

    foreach ($directory in @($resolved.deploymentRoot, $resolved.dataRoot, $resolved.backupRoot, $resolved.configRoot, $resolved.serviceRoot)) {
        if (-not (Test-Path -LiteralPath ([string]$directory) -PathType Container)) {
            New-Item -ItemType Directory -Path ([string]$directory) -Force | Out-Null
        }
    }
    $node = Get-TeamBootstrapNode -ConfigPath $ConfigPath
    $generator = Join-Path $PSScriptRoot 'generate-config.mjs'
    & $node $generator --config ([System.IO.Path]::GetFullPath($ConfigPath)) --output ([string]$resolved.serviceRoot) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'SCM/Caddy 配置生成失败' }

    foreach ($name in @('service-control.mjs', 'generate-config.mjs', 'distribution-lock.json', 'common.ps1', 'generate-config.ps1', 'install.ps1', 'status.ps1', 'stop.ps1', 'preflight.ps1', 'backup.ps1', 'restore.ps1', 'release.ps1')) {
        Copy-TeamFile -Source (Join-Path $PSScriptRoot $name) -Destination (Join-Path ([string]$resolved.serviceRoot) $name)
    }
    Copy-TeamFile -Source (Join-Path $PSScriptRoot '..\runtime\process-tree.mjs') -Destination (Join-Path ([string]$resolved.deploymentRoot) 'runtime\process-tree.mjs')

    $lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'distribution-lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($service in $resolved.services) {
        Copy-TeamFile -Source ([string]$resolved.winswExecutable) -Destination ([string]$service.wrapperExecutable)
        $actualHash = (Get-FileHash -LiteralPath ([string]$service.wrapperExecutable) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne ([string]$lock.winsw.sha256).ToLowerInvariant()) { throw 'WinSW 哈希与受控 manifest 不符' }
    }

    Grant-TeamAcl -Path ([string]$resolved.deploymentRoot) -Account ([string]$resolved.serviceAccount) -Permission 'R' -Recurse
    Grant-TeamAcl -Path ([string]$resolved.dataRoot) -Account ([string]$resolved.serviceAccount) -Permission 'M' -Recurse
    Grant-TeamAcl -Path ([string]$resolved.backupRoot) -Account ([string]$resolved.serviceAccount) -Permission 'M' -Recurse
    Ensure-TeamControlCredential -Resolved $resolved
    Set-TeamFirewall -Resolved $resolved

    foreach ($service in $resolved.services) {
        if (-not $existingServices[[string]$service.id]) {
            & ([string]$service.wrapperExecutable) install | Out-Null
            if ($LASTEXITCODE -ne 0) { throw ('SCM 安装失败：' + [string]$service.id) }
        }
    }
    $liteLLMWarning = $null
    foreach ($role in @('litellm', 'app', 'caddy')) {
        $service = @($resolved.services | Where-Object { $_.role -eq $role } | Select-Object -First 1)
        if ($service.Count -eq 0) { continue }
        try {
            if ((Get-Service -Name ([string]$service[0].id)).Status -ne 'Running') {
                Start-Service -Name ([string]$service[0].id) -ErrorAction Stop
            }
        } catch {
            if ($role -eq 'litellm') { $liteLLMWarning = '可选 LiteLLM 未启动；app 与外部供应商继续安装' }
            else { throw }
        }
    }
    $state = [ordered]@{
        schemaVersion = 1
        deploymentId = [string]$resolved.deploymentId
        releaseId = [string]$resolved.releaseId
        installedAt = [DateTime]::UtcNow.ToString('o')
    }
    [System.IO.File]::WriteAllText((Join-Path ([string]$resolved.serviceRoot) 'install-state.json'), (ConvertTo-Json $state -Compress), (New-Object System.Text.UTF8Encoding($false)))
    Write-TeamOperationJson -Value ([ordered]@{
        schemaVersion = 1
        action = 'install'
        dryRun = $false
        applyPerformed = $true
        deploymentId = [string]$resolved.deploymentId
        releaseId = [string]$resolved.releaseId
        services = @($resolved.services | ForEach-Object { $_.id })
        liteLLMWarning = $liteLLMWarning
        certificateTrustChanged = $false
        note = 'SCM installation only; no unattended-logoff/RDP/GPU acceptance is claimed.'
    })
    exit 0
} catch {
    [Console]::Error.WriteLine('安装失败：' + $_.Exception.Message)
    exit 1
}
