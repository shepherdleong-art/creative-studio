[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $false)][string]$ProbeSnapshotPath
)

# ProbeSnapshotPath 只用于隔离测试与报告复核；fixture 报告不能作为现场实测证据。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-PreflightReport {
    param([string]$Directory, [object]$Report)
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    }
    $reportPath = Join-Path $Directory 'preflight-report.json'
    $json = ConvertTo-Json -InputObject $Report -Depth 12
    [System.IO.File]::WriteAllText($reportPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    return $reportPath
}

function Test-DirectoryRights {
    param(
        [object[]]$Rules,
        [string[]]$SubjectSids,
        [System.Security.AccessControl.FileSystemRights]$RequiredRights
    )
    $allowed = [int]0
    $denied = $false
    foreach ($rule in $Rules) {
        if ($SubjectSids -notcontains $rule.IdentityReference.Value) { continue }
        $rights = [int]$rule.FileSystemRights
        $required = [int]$RequiredRights
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
            if (($rights -band $required) -ne 0) { $denied = $true }
        } elseif ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
            $allowed = $allowed -bor $rights
        }
    }
    return (-not $denied -and (($allowed -band [int]$RequiredRights) -eq [int]$RequiredRights))
}

function Get-DirectoryAccessSnapshot {
    param([string]$Path)
    $result = [pscustomobject]@{
        path = $Path
        exists = $null
        readAllowed = $null
        modifyAllowed = $null
    }
    try {
        $exists = Test-Path -LiteralPath $Path -PathType Container
    } catch {
        return $result
    }
    if (-not $exists) {
        $result.exists = $false
        return $result
    }
    $result.exists = $true
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $subjectSids = @($identity.User.Value) + @($identity.Groups | ForEach-Object { $_.Value })
        $acl = Get-Acl -LiteralPath $Path
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        $result.readAllowed = Test-DirectoryRights -Rules $rules -SubjectSids $subjectSids -RequiredRights ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
        $result.modifyAllowed = Test-DirectoryRights -Rules $rules -SubjectSids $subjectSids -RequiredRights ([System.Security.AccessControl.FileSystemRights]::Modify)
    } catch {
        $result.readAllowed = $null
        $result.modifyAllowed = $null
    }
    return $result
}

function Get-LiveSnapshot {
    param([object]$Config)
    $snapshot = [ordered]@{
        observedAt = [DateTime]::UtcNow.ToString('o')
        windows = $null
        cpu = @()
        memory = $null
        gpus = @()
        logicalDisks = @()
        physicalDisks = @()
        networkAdapters = @()
        tcpListeners = @()
        directoryAccess = @()
        directoryAccessSource = 'current-user-acl-conservative'
        collectionDiagnostics = @()
    }
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem
        $snapshot.windows = [pscustomobject]@{
            caption = [string]$os.Caption
            version = [string]$os.Version
            buildNumber = [string]$os.BuildNumber
            osArchitecture = [string]$os.OSArchitecture
        }
        $snapshot.memory = [pscustomobject]@{
            totalBytes = [math]::Round([double]$os.TotalVisibleMemorySize * 1024)
            freeBytes = [math]::Round([double]$os.FreePhysicalMemory * 1024)
        }
    } catch {
        $snapshot.collectionDiagnostics += [pscustomobject]@{ code = 'COLLECTION_INCOMPLETE'; subject = 'windows/memory'; message = 'Windows 版本或内存采集失败；对应字段保持为空' }
    }
    try {
        $snapshot.cpu = @(Get-CimInstance -ClassName Win32_Processor | ForEach-Object {
            [pscustomobject]@{
                name = [string]$_.Name
                cores = [int]$_.NumberOfCores
                logicalProcessors = [int]$_.NumberOfLogicalProcessors
            }
        })
    } catch {
        $snapshot.collectionDiagnostics += [pscustomobject]@{ code = 'COLLECTION_INCOMPLETE'; subject = 'cpu'; message = 'CPU 采集失败；对应字段保持为空' }
    }
    try {
        $snapshot.gpus = @(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object {
            [pscustomobject]@{
                name = [string]$_.Name
                driverVersion = [string]$_.DriverVersion
                adapterRamBytes = $(if ($null -eq $_.AdapterRAM) { $null } else { [double]$_.AdapterRAM })
                status = [string]$_.Status
            }
        })
    } catch {
        $snapshot.gpus = $null
        $snapshot.collectionDiagnostics += [pscustomobject]@{ code = 'COLLECTION_INCOMPLETE'; subject = 'gpu'; message = 'GPU/驱动采集失败；不能据此确认 NVENC 能力' }
    }
    try {
        $snapshot.logicalDisks = @(Get-CimInstance -ClassName Win32_LogicalDisk | ForEach-Object {
            [pscustomobject]@{
                deviceId = [string]$_.DeviceID
                volumeName = [string]$_.VolumeName
                driveType = [int]$_.DriveType
                fileSystem = [string]$_.FileSystem
                sizeBytes = $(if ($null -eq $_.Size) { $null } else { [double]$_.Size })
                freeBytes = $(if ($null -eq $_.FreeSpace) { $null } else { [double]$_.FreeSpace })
            }
        })
    } catch {
        $snapshot.collectionDiagnostics += [pscustomobject]@{ code = 'COLLECTION_INCOMPLETE'; subject = 'logicalDisks'; message = '逻辑磁盘采集失败；对应字段保持为空' }
    }
    try {
        $snapshot.physicalDisks = @(Get-CimInstance -ClassName Win32_DiskDrive | ForEach-Object {
            [pscustomobject]@{
                deviceId = [string]$_.DeviceID
                model = [string]$_.Model
                mediaType = [string]$_.MediaType
                interfaceType = [string]$_.InterfaceType
                sizeBytes = $(if ($null -eq $_.Size) { $null } else { [double]$_.Size })
                status = [string]$_.Status
            }
        })
    } catch {
        $snapshot.collectionDiagnostics += [pscustomobject]@{ code = 'COLLECTION_INCOMPLETE'; subject = 'physicalDisks'; message = '物理磁盘采集失败；对应字段保持为空' }
    }
    try {
        $snapshot.networkAdapters = @(Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE' | ForEach-Object {
            [pscustomobject]@{
                description = [string]$_.Description
                ipAddresses = @($_.IPAddress)
                subnets = @($_.IPSubnet)
                gateways = @($_.DefaultIPGateway)
                dnsServers = @($_.DNSServerSearchOrder)
                dhcpEnabled = [bool]$_.DHCPEnabled
            }
        })
    } catch {
        $snapshot.collectionDiagnostics += [pscustomobject]@{ code = 'COLLECTION_INCOMPLETE'; subject = 'network'; message = '网络配置采集失败；未发起远端连接' }
    }
    try {
        $snapshot.tcpListeners = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object {
            [pscustomobject]@{ address = $_.Address.ToString(); port = [int]$_.Port }
        })
    } catch {
        $snapshot.tcpListeners = $null
        $snapshot.collectionDiagnostics += [pscustomobject]@{ code = 'COLLECTION_INCOMPLETE'; subject = 'ports'; message = 'TCP 监听采集失败；端口状态不能视为已核实' }
    }
    $snapshot.directoryAccess = @($Config.directories | ForEach-Object { Get-DirectoryAccessSnapshot -Path ([string]$_.path) })
    return $snapshot
}

try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$config.schemaVersion -eq 1 -and $null -eq $config.ports -and $null -ne $config.appPort) {
        $config | Add-Member -NotePropertyName ports -NotePropertyValue @(
            [pscustomobject]@{ name = 'app'; host = $(if ($config.appHost) { [string]$config.appHost } else { '127.0.0.1' }); port = [int]$config.appPort },
            [pscustomobject]@{ name = 'litellm'; host = $(if ($config.liteLLMHost) { [string]$config.liteLLMHost } else { '127.0.0.1' }); port = [int]$config.liteLLMPort }
        )
    }
    if ([int]$config.schemaVersion -eq 1 -and $null -eq $config.directories -and $null -ne $config.deploymentRoot) {
        $derivedDirectories = @(
            [pscustomobject]@{ name = 'deployment'; path = [string]$config.deploymentRoot; requiredAccess = 'read'; isOld = $false },
            [pscustomobject]@{ name = 'data'; path = [string]$config.dataRoot; requiredAccess = 'modify'; isOld = $false },
            [pscustomobject]@{ name = 'backup'; path = [string]$config.backupRoot; requiredAccess = 'modify'; isOld = $false }
        )
        foreach ($oldRoot in @($config.oldRoots)) {
            $derivedDirectories += [pscustomobject]@{ name = 'old-data'; path = [string]$oldRoot; requiredAccess = 'read'; isOld = $true }
        }
        $config | Add-Member -NotePropertyName directories -NotePropertyValue $derivedDirectories
    }
    if ([int]$config.schemaVersion -ne 1 -or $null -eq $config.ports -or $null -eq $config.directories) {
        throw 'Invalid deployment config'
    }
    $outputFullPath = [System.IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
    foreach ($oldDirectory in @($config.directories | Where-Object { $_.isOld })) {
        $oldFullPath = [System.IO.Path]::GetFullPath([string]$oldDirectory.path).TrimEnd('\')
        if ($outputFullPath.Equals($oldFullPath, [System.StringComparison]::OrdinalIgnoreCase) -or
            $outputFullPath.StartsWith($oldFullPath + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Output directory must not modify an old directory'
        }
    }
    $collectionSource = 'fixture'
    if ($ProbeSnapshotPath) {
        $snapshot = Get-Content -LiteralPath $ProbeSnapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $collectionSource = 'live-windows'
        $snapshot = Get-LiveSnapshot -Config $config
    }
    $diagnostics = @($snapshot.collectionDiagnostics | Where-Object { $null -ne $_ })

    $gpuItems = @($snapshot.gpus | Where-Object { $null -ne $_ })
    if ($null -eq $snapshot.gpus) {
        $diagnostics += [pscustomobject]@{
            code = 'GPU_STATUS_UNKNOWN'
            subject = 'gpu'
            message = 'GPU/驱动状态未知；不能将采集失败当作无 GPU 或 NVENC 可用'
        }
    } elseif ($gpuItems.Count -eq 0) {
        $diagnostics += [pscustomobject]@{
            code = 'GPU_NOT_DETECTED'
            subject = 'gpu'
            message = '未检测到 GPU；不能据此确认 NVENC 能力，需在现场安装/驱动与服务账号下复核'
        }
    }

    $oldDirectories = @($config.directories | Where-Object { $_.isOld })
    $newDirectories = @($config.directories | Where-Object { -not $_.isOld })
    foreach ($newDirectory in $newDirectories) {
        $newFullPath = [System.IO.Path]::GetFullPath([string]$newDirectory.path).TrimEnd('\')
        foreach ($oldDirectory in $oldDirectories) {
            $oldFullPath = [System.IO.Path]::GetFullPath([string]$oldDirectory.path).TrimEnd('\')
            $newInsideOld = $newFullPath.Equals($oldFullPath, [System.StringComparison]::OrdinalIgnoreCase) -or
                $newFullPath.StartsWith($oldFullPath + '\', [System.StringComparison]::OrdinalIgnoreCase)
            $oldInsideNew = $oldFullPath.Equals($newFullPath, [System.StringComparison]::OrdinalIgnoreCase) -or
                $oldFullPath.StartsWith($newFullPath + '\', [System.StringComparison]::OrdinalIgnoreCase)
            if ($newInsideOld -or $oldInsideNew) {
                $diagnostics += [pscustomobject]@{
                    code = 'DIRECTORY_OVERLAP'
                    subject = ([string]$newDirectory.name + '/' + [string]$oldDirectory.name)
                    message = '新旧目录不得相同或互相包含；旧目录必须原处保留'
                }
            }
        }
    }

    $portEvidenceAvailable = $null -ne $snapshot.tcpListeners
    if (-not $portEvidenceAvailable) {
        $diagnostics += [pscustomobject]@{
            code = 'PORT_STATUS_UNKNOWN'
            subject = 'ports'
            message = 'TCP 监听证据缺失；所有选定端口保持未知，不视为可用'
        }
    }
    $ports = @($config.ports | ForEach-Object {
        $requested = $_
        $occupied = $false
        if ($portEvidenceAvailable) {
            $occupied = @($snapshot.tcpListeners | Where-Object {
                if ([int]$_.port -ne [int]$requested.port) { return $false }
                $listenerAddress = [System.Net.IPAddress]::Parse([string]$_.address)
                $requestedAddress = [System.Net.IPAddress]::Parse([string]$requested.host)
                return $listenerAddress.Equals($requestedAddress) -or
                    $listenerAddress.Equals([System.Net.IPAddress]::Any) -or
                    $listenerAddress.Equals([System.Net.IPAddress]::IPv6Any)
            }).Count -gt 0
        }
        if ($occupied) {
            $diagnostics += [pscustomobject]@{
                code = 'PORT_OCCUPIED'
                subject = [string]$requested.name
                message = '选定端口已有 TCP 监听；预检未尝试停止或认领该进程'
            }
        }
        [pscustomobject]@{
            name = [string]$requested.name
            host = [string]$requested.host
            port = [int]$requested.port
            status = $(if (-not $portEvidenceAvailable) { 'unknown' } elseif ($occupied) { 'occupied' } else { 'available' })
        }
    })

    $directories = @($config.directories | ForEach-Object {
        $requested = $_
        $access = @($snapshot.directoryAccess | Where-Object {
            [string]::Equals([string]$_.path, [string]$requested.path, [System.StringComparison]::OrdinalIgnoreCase)
        } | Select-Object -First 1)
        $status = 'ok'
        if ($access.Count -eq 0 -or ($null -ne $access[0].exists -and -not $access[0].exists)) {
            $status = 'missing'
            $diagnostics += [pscustomobject]@{
                code = 'DIRECTORY_MISSING'
                subject = [string]$requested.name
                message = '指定目录不存在或没有目录存在性证据'
            }
        } elseif ($null -eq $access[0].readAllowed -or ($requested.requiredAccess -eq 'modify' -and $null -eq $access[0].modifyAllowed)) {
            $status = 'unknown'
            $diagnostics += [pscustomobject]@{
                code = 'DIRECTORY_PERMISSION_UNKNOWN'
                subject = [string]$requested.name
                message = '目录 ACL 无法读取；权限保持未知，需以实际服务账号复核'
            }
        } elseif ($requested.requiredAccess -eq 'modify' -and -not $access[0].modifyAllowed) {
            $status = 'permission-denied'
            $diagnostics += [pscustomobject]@{
                code = 'DIRECTORY_PERMISSION_INSUFFICIENT'
                subject = [string]$requested.name
                message = '当前账号缺少指定目录所需的修改权限'
            }
        } elseif (-not $access[0].readAllowed) {
            $status = 'permission-denied'
            $diagnostics += [pscustomobject]@{
                code = 'DIRECTORY_PERMISSION_INSUFFICIENT'
                subject = [string]$requested.name
                message = '当前账号缺少指定目录所需的读取权限'
            }
        }
        [pscustomobject]@{
            name = [string]$requested.name
            path = [string]$requested.path
            requiredAccess = [string]$requested.requiredAccess
            isOld = [bool]$requested.isOld
            accessSource = $(if ($collectionSource -eq 'fixture') { 'fixture' } else { 'current-user-acl-conservative' })
            status = $status
            readAllowed = $(if ($access.Count -eq 0) { $null } else { $access[0].readAllowed })
            modifyAllowed = $(if ($access.Count -eq 0) { $null } else { $access[0].modifyAllowed })
        }
    })

    $report = [ordered]@{
        schemaVersion = 1
        status = $(if ($diagnostics.Count -eq 0) { 'passed' } else { 'failed' })
        collection = [ordered]@{
            source = $collectionSource
            observedAt = [string]$snapshot.observedAt
            liveHostClaim = ($collectionSource -eq 'live-windows')
        }
        host = [ordered]@{
            windows = $snapshot.windows
            cpu = @($snapshot.cpu)
            memory = $snapshot.memory
            gpus = $(if ($null -eq $snapshot.gpus) { $null } else { $gpuItems })
            logicalDisks = @($snapshot.logicalDisks)
            physicalDisks = @($snapshot.physicalDisks)
            networkAdapters = @($snapshot.networkAdapters)
        }
        ports = $ports
        directories = $directories
        diagnostics = @($diagnostics)
    }
    $reportPath = Write-PreflightReport -Directory $OutputDirectory -Report $report
    Write-Host ("预检{0}；报告：{1}" -f $(if ($diagnostics.Count -eq 0) { '通过' } else { '未通过' }), $reportPath)
    if ($diagnostics.Count -gt 0) { exit 1 }
    exit 0
} catch {
    Write-Host '预检输入或采集失败；未输出原始错误内容'
    exit 2
}
