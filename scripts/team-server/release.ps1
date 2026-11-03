#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$DeploymentId = '',
    [Parameter(Mandatory = $true)][string]$NewReleaseId,
    [Parameter(Mandatory = $true)][string]$OperationId,
    [ValidateSet('update', 'compatible-rollback', 'restore-rollback')][string]$Mode = 'update',
    [string]$CompatibilityReportPath = '',
    [string]$BackupId = '',
    [ValidateSet('daily', 'manual', 'pre-upgrade')][string]$BackupType = 'pre-upgrade',
    [string]$RestoreRoot = '',
    [switch]$Apply
)
. (Join-Path $PSScriptRoot 'common.ps1')

try {
    $resolved = Resolve-TeamDeployment -ConfigPath $ConfigPath -DeploymentId $DeploymentId
    if (-not $Apply) {
        Write-TeamOperationJson -Value ([ordered]@{
            schemaVersion = 1
            action = 'release'
            mode = $Mode
            dryRun = $true
            applyPerformed = $false
            deploymentId = [string]$resolved.deploymentId
            currentReleaseId = [string]$resolved.releaseId
            targetReleaseId = $NewReleaseId
            operationId = $OperationId
            backupId = $BackupId
            restoreRoot = $RestoreRoot
            maintenanceOnFailure = $true
        })
        exit 0
    }
    foreach ($root in @($resolved.deploymentRoot, $resolved.dataRoot, $resolved.backupRoot, $resolved.releaseRoot)) {
        Assert-NoReparsePoint -Path ([string]$root)
    }
    $node = Get-TeamBootstrapNode -ConfigPath $ConfigPath
    $runner = Get-TeamMaintenanceRunner -Resolved $resolved
    $command = if ($Mode -eq 'update') { 'release' } else { 'rollback' }
    $arguments = @($runner, $command, '--config', [System.IO.Path]::GetFullPath($ConfigPath),
        '--new-release-id', $NewReleaseId, '--operation-id', $OperationId)
    if ($Mode -eq 'compatible-rollback') { $arguments += @('--strategy', 'compatible') }
    if ($Mode -eq 'restore-rollback') {
        if (-not $BackupId -or -not $RestoreRoot) { throw '数据不兼容恢复必须显式提供 BackupId 与全新 RestoreRoot' }
        $arguments += @('--strategy', 'restore', '--backup-id', $BackupId, '--backup-type', $BackupType,
            '--restore-root', [System.IO.Path]::GetFullPath($RestoreRoot))
    }
    if ($CompatibilityReportPath) { $arguments += @('--compatibility-report', [System.IO.Path]::GetFullPath($CompatibilityReportPath)) }
    $raw = (& $node @arguments) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $raw) { throw '发布/回退失败；保持维护状态并记录可续跑阶段' }
    $result = $raw | ConvertFrom-Json
    Write-TeamOperationJson -Value ([ordered]@{
        schemaVersion = 1
        action = 'release'
        mode = $Mode
        dryRun = $false
        applyPerformed = $true
        deploymentId = [string]$resolved.deploymentId
        result = $result
    })
    exit 0
} catch {
    [Console]::Error.WriteLine('发布/回退失败：' + $_.Exception.Message)
    exit 1
}
