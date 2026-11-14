param([int]$ServerPid,[string]$OutputPath,[string]$StopFile)
$ErrorActionPreference='Stop'
while(-not (Test-Path -LiteralPath $StopFile)){
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$ServerPid"
 if(-not $p){break}
 $row=[pscustomobject]@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pid=$ServerPid;workingSet=[long]$p.WorkingSetSize;privateBytes=[long]$p.PrivatePageCount;readBytes=[long]$p.ReadTransferCount;writeBytes=[long]$p.WriteTransferCount;readOperations=[long]$p.ReadOperationCount;writeOperations=[long]$p.WriteOperationCount;kernel100ns=[long]$p.KernelModeTime;user100ns=[long]$p.UserModeTime}
 [IO.File]::AppendAllText($OutputPath,($row | ConvertTo-Json -Compress)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 Start-Sleep -Seconds 2
}