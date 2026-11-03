#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$DeploymentId = '',
    [Parameter(Mandatory = $true)][string]$BackupId,
    [Parameter(Mandatory = $true)][ValidateSet('daily', 'manual', 'pre-upgrade')][string]$BackupType,
    [Parameter(Mandatory = $true)][string]$RestoreRoot,
    [switch]$Apply
)
. (Join-Path $PSScriptRoot 'common.ps1')

try {
    $resolved = Resolve-TeamDeployment -ConfigPath $ConfigPath -DeploymentId $DeploymentId
    $fullRestoreRoot = [System.IO.Path]::GetFullPath($RestoreRoot)
    if (-not $Apply) {
        Write-TeamOperationJson -Value ([ordered]@{
            schemaVersion = 1
            action = 'restore'
            dryRun = $true
            applyPerformed = $false
            deploymentId = [string]$resolved.deploymentId
            releaseId = [string]$resolved.releaseId
            backupId = $BackupId
            backupType = $BackupType
            restoreRoot = $fullRestoreRoot
            scheduling = $false
            automaticRetries = $false
        })
        exit 0
    }
    foreach ($root in @($resolved.dataRoot, $resolved.backupRoot, $resolved.releaseRoot, $fullRestoreRoot)) {
        Assert-NoReparsePoint -Path ([string]$root)
    }
    $node = Get-TeamBootstrapNode -ConfigPath $ConfigPath
    $runner = Join-Path $PSScriptRoot 'maintenance.mjs'
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
        $runner = Join-Path $PSScriptRoot '..\app\scripts\team-server\maintenance.mjs'
    }
    $raw = (& $node $runner 'restore' '--config' ([System.IO.Path]::GetFullPath($ConfigPath)) `
        '--backup-id' $BackupId '--backup-type' $BackupType '--restore-root' $fullRestoreRoot) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $raw) { throw '隔离恢复失败；旧根与 journal 未改写' }
    $result = $raw | ConvertFrom-Json
    Write-TeamOperationJson -Value ([ordered]@{
        schemaVersion = 1
        action = 'restore'
        dryRun = $false
        applyPerformed = $true
        deploymentId = [string]$resolved.deploymentId
        scheduling = $false
        automaticRetries = $false
        result = $result
    })
    exit 0
} catch {
    [Console]::Error.WriteLine('恢复失败：' + $_.Exception.Message)
    exit 1
}
