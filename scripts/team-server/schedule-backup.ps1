#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$DeploymentId = '',
    [ValidateSet('preview', 'apply', 'status', 'remove')][string]$Action = 'preview',
    [string]$Time = '02:30',
    [string]$TimeZone = '',
    [string]$Account = '',
    [ValidateSet('S4U', 'ServiceAccount')][string]$LogonType = 'S4U',
    [switch]$Disabled
)
# 只管理本部署的每日备份计划任务：预览不写系统，apply/remove 先验证同名任务归属。
. (Join-Path $PSScriptRoot 'common.ps1')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Test-TeamSafeId {
    param([string]$Value, [string]$Label)
    if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or $Value.Contains('..')) {
        throw ($Label + ' 无效')
    }
}

function Get-TeamDailyBackupPlan {
    param([object]$Resolved, [string]$TaskTime, [string]$TaskTimeZone, [string]$TaskAccount, [string]$TaskLogonType, [bool]$TaskEnabled)
    Test-TeamSafeId -Value ([string]$Resolved.deploymentId) -Label 'deploymentId'
    if ($TaskTime -notmatch '^([01]\d|2[0-3]):([0-5]\d)$') { throw '每日备份时间必须是 HH:mm（24 小时制）' }
    $zoneId = $TaskTimeZone
    if (-not $zoneId) { $zoneId = [System.TimeZoneInfo]::Local.Id }
    $zone = $null
    try { $zone = [System.TimeZoneInfo]::FindSystemTimeZoneById($zoneId) } catch { throw '时区标识在本机不可用' }
    $nowZone = [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $zone)
    $scheduled = $nowZone.Date.Add([TimeSpan]::Parse($TaskTime))
    if ($scheduled -le $nowZone) { $scheduled = $scheduled.AddDays(1) }
    $serviceRoot = [string]$Resolved.serviceRoot
    $backupScript = Join-Path $serviceRoot 'backup.ps1'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) { throw '缺少本机 Windows PowerShell 绝对路径' }
    if (-not [System.IO.Path]::IsPathRooted($backupScript)) { throw '备份脚本必须是绝对路径' }
    $configFull = [System.IO.Path]::GetFullPath([string]$Resolved.configPath)
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $backupScript + '" -ConfigPath "' + $configFull + '" -DeploymentId "' + [string]$Resolved.deploymentId + '" -Type daily -Apply'
    $description = 'Creative Studio team daily backup; deploymentId=' + [string]$Resolved.deploymentId + '; managed by schedule-backup.ps1'
    return [ordered]@{
        taskName = 'CreativeStudioTeamBackup-' + [string]$Resolved.deploymentId
        deploymentId = [string]$Resolved.deploymentId
        description = $description
        account = $TaskAccount
        logonType = $TaskLogonType
        timeZone = $zone.Id
        startBoundary = $scheduled.ToString('yyyy-MM-ddTHH:mm:ss')
        enabled = $TaskEnabled
        command = [System.IO.Path]::GetFullPath($powershell)
        arguments = $arguments
        workingDirectory = $serviceRoot
        backupScript = [System.IO.Path]::GetFullPath($backupScript)
        configPath = $configFull
        nodeExecutable = [string]$Resolved.nodeExecutable
        dailyJobFile = Join-Path ([string]$Resolved.backupRoot) 'daily-job.json'
    }
}

function Test-TeamTaskOwnership {
    param([object]$Task, [object]$Plan)
    if (-not $Task) { return [ordered]@{ registered = $false; managed = $false; conflict = $false } }
    $description = ''
    try { $description = [string]$Task.Description } catch {}
    $action = @($Task.Actions)[0]
    $command = ''
    $arguments = ''
    if ($action) {
        $command = [string]$action.Execute
        $arguments = [string]$action.Arguments
    }
    $managed = $description.Equals([string]$Plan.description, [System.StringComparison]::Ordinal) -and
        $command.Equals([string]$Plan.command, [System.StringComparison]::OrdinalIgnoreCase) -and
        $arguments.Contains('"' + [string]$Plan.backupScript + '"') -and
        $arguments.Contains('"' + [string]$Plan.configPath + '"') -and
        $arguments.Contains('-DeploymentId "' + [string]$Plan.deploymentId + '"') -and
        $arguments.Contains('-Type daily')
    return [ordered]@{ registered = $true; managed = $managed; conflict = (-not $managed); description = $description }
}

function Get-TeamTaskState {
    param([string]$TaskName)
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return $null }
    return $task
}

function Read-TeamDailyJob {
    param([string]$File)
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return [ordered]@{ status = 'unreadable' } }
}

function Write-TeamScheduleResult {
    param([object]$Value)
    Write-TeamOperationJson -Value $Value
}

try {
    $resolved = Resolve-TeamDeployment -ConfigPath $ConfigPath -DeploymentId $DeploymentId
    $resolved | Add-Member -NotePropertyName configPath -NotePropertyValue ([System.IO.Path]::GetFullPath($ConfigPath)) -Force
    $account = $Account
    if (-not $account) { $account = [string]$resolved.serviceAccount }
    $enabled = -not $Disabled.IsPresent
    $plan = Get-TeamDailyBackupPlan -Resolved $resolved -TaskTime $Time -TaskTimeZone $TimeZone -TaskAccount $account -TaskLogonType $LogonType -TaskEnabled $enabled
    $existing = Get-TeamTaskState -TaskName ([string]$plan.taskName)
    $ownership = Test-TeamTaskOwnership -Task $existing -Plan $plan

    if ($Action -eq 'preview') {
        Write-TeamScheduleResult -Value ([ordered]@{
            schemaVersion = 1
            action = 'backup-schedule'
            dryRun = $true
            applyPerformed = $false
            deploymentId = [string]$resolved.deploymentId
            plan = $plan
            existing = $ownership
            networkNote = '该计划任务兼容无人登录；参数预览不写系统。'
        })
        exit 0
    }

    if ($Action -eq 'status') {
        $info = $null
        if ($existing) { try { $info = Get-ScheduledTaskInfo -TaskName ([string]$plan.taskName) } catch {} }
        $dailyJob = Read-TeamDailyJob -File ([string]$plan.dailyJobFile)
        Write-TeamScheduleResult -Value ([ordered]@{
            schemaVersion = 1
            action = 'backup-schedule-status'
            dryRun = $false
            applyPerformed = $false
            deploymentId = [string]$resolved.deploymentId
            taskName = [string]$plan.taskName
            registered = [bool]$ownership.registered
            managed = [bool]$ownership.managed
            conflict = [bool]$ownership.conflict
            enabled = $(if ($existing) { [bool]$existing.Settings.Enabled } else { $false })
            lastRunTime = $(if ($info) { $info.LastRunTime } else { $null })
            lastTaskResult = $(if ($info) { $info.LastTaskResult } else { $null })
            nextRunTime = $(if ($info) { $info.NextRunTime } else { $null })
            account = [string]$plan.account
            logonType = [string]$plan.logonType
            timeZone = [string]$plan.timeZone
            dailyJob = $dailyJob
            latestRecoveryEvidence = $(if ($dailyJob) { $dailyJob.latestRecoveryEvidence } else { $null })
            restoreHold = (Test-Path -LiteralPath (Join-Path ([string]$resolved.dataRoot) 'storage\maintenance\restore-hold.json') -PathType Leaf)
        })
        exit 0
    }

    if ($ownership.conflict) { throw '同名计划任务不属于本部署，拒绝修改或删除' }

    if ($Action -eq 'remove') {
        if (-not $existing) {
            Write-TeamScheduleResult -Value ([ordered]@{
                schemaVersion = 1; action = 'backup-schedule-remove'; dryRun = $false; applyPerformed = $false
                deploymentId = [string]$resolved.deploymentId; taskName = [string]$plan.taskName; removed = $false
            })
            exit 0
        }
        Unregister-ScheduledTask -TaskName ([string]$plan.taskName) -Confirm:$false
        Write-TeamScheduleResult -Value ([ordered]@{
            schemaVersion = 1; action = 'backup-schedule-remove'; dryRun = $false; applyPerformed = $true
            deploymentId = [string]$resolved.deploymentId; taskName = [string]$plan.taskName; removed = $true
        })
        exit 0
    }

    if (-not (Test-Path -LiteralPath ([string]$plan.nodeExecutable) -PathType Leaf)) {
        throw '锁定 Node 运行时缺失；计划任务不得回退到交互 PATH'
    }
    if (-not (Test-Path -LiteralPath ([string]$plan.backupScript) -PathType Leaf)) {
        throw '服务根缺少 backup.ps1，拒绝注册无法执行的计划任务'
    }
    $enabledText = $(if ($enabled) { 'true' } else { 'false' })
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$([System.Security.SecurityElement]::Escape([string]$plan.description))</Description>
    <URI>\$([System.Security.SecurityElement]::Escape([string]$plan.taskName))</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$([string]$plan.startBoundary)</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$([System.Security.SecurityElement]::Escape([string]$plan.account))</UserId>
      <LogonType>$([string]$plan.logonType)</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT6H</ExecutionTimeLimit>
    <Enabled>$enabledText</Enabled>
    <TimeZone>$([System.Security.SecurityElement]::Escape([string]$plan.timeZone))</TimeZone>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$([System.Security.SecurityElement]::Escape([string]$plan.command))</Command>
      <Arguments>$([System.Security.SecurityElement]::Escape([string]$plan.arguments))</Arguments>
      <WorkingDirectory>$([System.Security.SecurityElement]::Escape([string]$plan.workingDirectory))</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
    Register-ScheduledTask -TaskName ([string]$plan.taskName) -Xml $xml -Force | Out-Null
    Write-TeamScheduleResult -Value ([ordered]@{
        schemaVersion = 1
        action = 'backup-schedule-apply'
        dryRun = $false
        applyPerformed = $true
        deploymentId = [string]$resolved.deploymentId
        taskName = [string]$plan.taskName
        account = [string]$plan.account
        logonType = [string]$plan.logonType
        timeZone = [string]$plan.timeZone
        startBoundary = [string]$plan.startBoundary
        enabled = $enabled
    })
    exit 0
} catch {
    [Console]::Error.WriteLine('备份计划任务操作失败：' + $_.Exception.Message)
    exit 1
}
