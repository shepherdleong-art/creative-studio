#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$DeploymentId,
    [switch]$Apply
)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $resolved = Resolve-TeamDeployment -ConfigPath $ConfigPath -DeploymentId $DeploymentId
    if (-not $Apply) {
        Write-TeamOperationJson -Value ([ordered]@{
            schemaVersion = 1
            action = 'stop'
            dryRun = $true
            applyPerformed = $false
            deploymentId = [string]$resolved.deploymentId
            services = @($resolved.services | ForEach-Object { $_.id })
            order = @('app-graceful-shutdown', 'litellm-scm', 'caddy-scm')
            note = 'No request, service control or process action was performed.'
        })
        exit 0
    }
    $servicePresence = @{}
    foreach ($service in $resolved.services) { $servicePresence[[string]$service.id] = Assert-TeamServiceTarget -Service $service }
    $appService = @($resolved.services | Where-Object { $_.role -eq 'app' } | Select-Object -First 1)[0]
    if (-not $servicePresence[[string]$appService.id]) { throw '应用 SCM 服务不存在，不按端口认领未知进程' }
    $helper = Join-Path ([string]$resolved.serviceRoot) 'service-control.mjs'
    $config = Join-Path ([string]$resolved.serviceRoot) 'resolved-services.json'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf) -or -not (Test-Path -LiteralPath $config -PathType Leaf) -or
        -not (Test-Path -LiteralPath ([string]$resolved.controlCredentialFile) -PathType Leaf)) {
        throw '受控停机入口或凭据缺失'
    }
    $raw = (& ([string]$resolved.nodeExecutable) $helper stop --config $config --credential-file ([string]$resolved.controlCredentialFile) --apply --force-after-timeout) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw '应用优雅停机或本实例进程树退出核验失败' }
    $app = $raw | ConvertFrom-Json
    if (-not $app.stopped) { throw '应用仍有残留进程，未继续停止依赖服务' }

    # Dependency order: app helper -> CreativeStudioLiteLLM -> CreativeStudioCaddy (role equivalents).
    $stopped = @()
    foreach ($role in @('litellm', 'caddy')) {
        $service = @($resolved.services | Where-Object { $_.role -eq $role } | Select-Object -First 1)
        if ($service.Count -eq 0) { continue }
        $id = [string]$service[0].id
        if ($servicePresence[$id]) {
            Stop-Service -Name $id -Force -ErrorAction Stop
            $stopped += $id
        }
    }
    Write-TeamOperationJson -Value ([ordered]@{
        schemaVersion = 1
        action = 'stop'
        dryRun = $false
        applyPerformed = $true
        deploymentId = [string]$resolved.deploymentId
        app = $app
        stoppedDependentServices = $stopped
        residualPids = @($app.residualPids)
        recoveryNote = 'Review pendingTasks and execution receipts before accepting new paid work.'
    })
    exit 0
} catch {
    [Console]::Error.WriteLine('停止失败：' + $_.Exception.Message)
    exit 1
}
