#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$DeploymentId = '',
    [switch]$Apply
)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $resolved = Resolve-TeamDeployment -ConfigPath $ConfigPath -DeploymentId $DeploymentId
    if (-not $Apply) {
        Write-TeamOperationJson -Value ([ordered]@{
            schemaVersion = 1
            action = 'status'
            dryRun = $true
            applyPerformed = $false
            deploymentId = [string]$resolved.deploymentId
            releaseId = [string]$resolved.releaseId
            services = @($resolved.services | ForEach-Object { $_.id })
            note = 'No SCM, port or process was queried; use -Apply for the read-only live report.'
        })
        exit 0
    }
    foreach ($service in $resolved.services) { [void](Assert-TeamServiceTarget -Service $service) }
    $helper = Join-Path ([string]$resolved.serviceRoot) 'service-control.mjs'
    $config = Join-Path ([string]$resolved.serviceRoot) 'resolved-services.json'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf) -or -not (Test-Path -LiteralPath $config -PathType Leaf) -or
        -not (Test-Path -LiteralPath ([string]$resolved.controlCredentialFile) -PathType Leaf)) {
        throw '受控状态接口或凭据缺失，不能用端口探测代替实例状态'
    }
    $raw = (& ([string]$resolved.nodeExecutable) $helper status --config $config --credential-file ([string]$resolved.controlCredentialFile)) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw '应用 live/ready、实例或进程树状态获取失败' }
    $app = $raw | ConvertFrom-Json
    $services = @($resolved.services | ForEach-Object {
        $current = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + [string]$_.id + "'")
        [pscustomobject]@{ id = [string]$_.id; state = [string]$current.State; processId = [int]$current.ProcessId; owned = $true }
    })
    Write-TeamOperationJson -Value ([ordered]@{
        schemaVersion = 1
        action = 'status'
        dryRun = $false
        applyPerformed = $false
        deploymentId = [string]$resolved.deploymentId
        instanceId = [string]$app.instanceId
        app = $app
        services = $services
    })
    exit 0
} catch {
    [Console]::Error.WriteLine('状态检查失败：' + $_.Exception.Message)
    exit 1
}
