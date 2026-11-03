#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$DeploymentId = '',
    [Parameter(Mandatory = $true)][ValidateSet('daily', 'manual', 'pre-upgrade')][string]$Type,
    [string]$BackupId = '',
    [switch]$Apply
)
. (Join-Path $PSScriptRoot 'common.ps1')

try {
    $resolved = Resolve-TeamDeployment -ConfigPath $ConfigPath -DeploymentId $DeploymentId
    if (-not $Apply) {
        Write-TeamOperationJson -Value ([ordered]@{
            schemaVersion = 1
            action = 'backup'
            dryRun = $true
            applyPerformed = $false
            deploymentId = [string]$resolved.deploymentId
            releaseId = [string]$resolved.releaseId
            backupType = $Type
            backupId = $BackupId
            backupRoot = [string]$resolved.backupRoot
            dailyJobEntry = 'backup.ps1 -Type daily -Apply'
        })
        exit 0
    }
    foreach ($root in @($resolved.deploymentRoot, $resolved.dataRoot, $resolved.backupRoot, $resolved.releaseRoot)) {
        Assert-NoReparsePoint -Path ([string]$root)
    }
    $node = Get-TeamBootstrapNode -ConfigPath $ConfigPath
    $runner = Get-TeamMaintenanceRunner -Resolved $resolved
    $arguments = @($runner, 'backup', '--config', [System.IO.Path]::GetFullPath($ConfigPath), '--type', $Type)
    if ($BackupId) { $arguments += @('--backup-id', $BackupId) }
    $raw = (& $node @arguments) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $raw) { throw '一致性备份失败；成功副本未轮换' }
    $result = $raw | ConvertFrom-Json
    Write-TeamOperationJson -Value ([ordered]@{
        schemaVersion = 1
        action = 'backup'
        dryRun = $false
        applyPerformed = $true
        deploymentId = [string]$resolved.deploymentId
        result = $result
    })
    exit 0
} catch {
    [Console]::Error.WriteLine('备份失败：' + $_.Exception.Message)
    exit 1
}
