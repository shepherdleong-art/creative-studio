#Requires -Version 5.1
# Shared, non-secret helpers. This file never prints configuration or credential contents.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-TeamBootstrapNode {
    param([string]$ConfigPath)
    $candidates = @()
    if ($env:CREATIVE_STUDIO_TEAM_NODE) { $candidates += $env:CREATIVE_STUDIO_TEAM_NODE }
    $candidates += (Join-Path $PSScriptRoot '..\runtimes\node\node.exe')
    try {
        $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($raw.deploymentRoot -and $raw.releaseId) {
            $candidates += (Join-Path ([string]$raw.deploymentRoot) ('releases\' + [string]$raw.releaseId + '\runtimes\node\node.exe'))
        }
    } catch {}
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            # Node 22 的 Undici 实验警告写 stderr；PS 5.1 会将其升级为 NativeCommandError。
            return '--disable-warning=UNDICI-EHPA', [System.IO.Path]::GetFullPath($candidate)
        }
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw '未找到锁定 Node 运行时'
}

function Get-TeamMaintenanceRunner {
    param([object]$Resolved)
    $releaseRoot = [string]$Resolved.releaseRoot
    $pointer = Join-Path ([string]$Resolved.serviceRoot) 'current-release.json'
    if (Test-Path -LiteralPath $pointer -PathType Leaf) {
        $current = Get-Content -LiteralPath $pointer -Raw -Encoding UTF8 | ConvertFrom-Json
        $releaseId = [string]$current.releaseId
        if ($releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or $releaseId.Contains('..')) {
            throw '当前 release 指针包含无效标识'
        }
        $releaseRoot = Join-Path ([string]$Resolved.deploymentRoot) ('releases\' + $releaseId)
    }
    $runner = Join-Path $releaseRoot 'app\scripts\team-server\maintenance.mjs'
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
        throw '当前 release 缺少维护 runner，拒绝执行维护操作'
    }
    return [System.IO.Path]::GetFullPath($runner)
}

function Resolve-TeamDeployment {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [string]$DeploymentId = ''
    )
    $fullConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
    $node = Get-TeamBootstrapNode -ConfigPath $fullConfigPath
    $generator = Join-Path $PSScriptRoot 'generate-config.mjs'
    # 纯 JS 生成器的退出码与 JSON 是成功凭据；PS 5.1 不应把其 Node 警告升级为异常。
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $raw = (& $node $generator --config $fullConfigPath --resolve-only 2>$null) -join "`n"
    $generatorExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorPreference
    if ($generatorExitCode -ne 0 -or -not $raw) { throw '部署配置无效；未创建目录或更改系统' }
    $resolved = $raw | ConvertFrom-Json
    if ($DeploymentId -and -not [string]::Equals([string]$resolved.deploymentId, $DeploymentId, [System.StringComparison]::Ordinal)) {
        throw '部署 ID 与选定配置不一致'
    }
    return $resolved
}

function Assert-NoReparsePoint {
    param([string]$Path)
    $current = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw '部署路径不得包含目录链接或 reparse point'
            }
        }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent.TrimEnd('\')
    }
}

function Get-ServiceExecutablePath {
    param([string]$PathName)
    $match = [regex]::Match($PathName, '^\s*"([^"]+\.exe)"|^\s*([^\s]+\.exe)(?:\s|$)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) { return '' }
    if ($match.Groups[1].Success) { return [System.IO.Path]::GetFullPath($match.Groups[1].Value) }
    return [System.IO.Path]::GetFullPath($match.Groups[2].Value)
}

function Assert-TeamServiceTarget {
    param([object]$Service)
    $existing = Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + [string]$Service.id + "'") -ErrorAction SilentlyContinue
    if (-not $existing) { return $false }
    $actual = Get-ServiceExecutablePath -PathName ([string]$existing.PathName)
    $expected = [System.IO.Path]::GetFullPath([string]$Service.wrapperExecutable)
    if (-not $actual -or -not $actual.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw ('拒绝认领未知 SCM 服务：' + [string]$Service.id)
    }
    return $true
}

function Write-TeamOperationJson {
    param([object]$Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 10 -Compress
    [Console]::Out.WriteLine($json)
}

function Copy-TeamFile {
    param([string]$Source, [string]$Destination)
    $sourceFull = [System.IO.Path]::GetFullPath($Source)
    $destinationFull = [System.IO.Path]::GetFullPath($Destination)
    if ($sourceFull.Equals($destinationFull, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    $parent = [System.IO.Path]::GetDirectoryName($destinationFull)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $sourceFull -Destination $destinationFull -Force
}

function Grant-TeamAcl {
    param([string]$Path, [string]$Account, [string]$Permission, [switch]$Recurse)
    $inheritance = $(if ($Recurse) { '(OI)(CI)' } else { '' })
    $args = @($Path, '/inheritance:r', '/grant:r', ('*S-1-5-18:' + $inheritance + 'F'), ('*S-1-5-32-544:' + $inheritance + 'F'))
    if ($Recurse) {
        $args += (@($Account + ':(OI)(CI)' + $Permission))
    } else {
        $args += (@($Account + ':' + $Permission))
    }
    $output = & icacls.exe @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'ACL 设置失败；未输出路径规则或账号以外信息' }
}

function ConvertTo-TeamNetworkKey {
    param([string]$Value)
    $parts = $Value.Split('/')
    if ($parts.Count -gt 2) { throw 'Invalid firewall network' }
    $address = [System.Net.IPAddress]::Parse($parts[0]).GetAddressBytes()
    $mask = New-Object byte[] $address.Length
    if ($parts.Count -eq 2 -and $parts[1] -notmatch '^\d+$') {
        $mask = [System.Net.IPAddress]::Parse($parts[1]).GetAddressBytes()
        if ($mask.Length -ne $address.Length) { throw 'Invalid firewall netmask family' }
        $bits = ($mask | ForEach-Object { [Convert]::ToString($_, 2).PadLeft(8, '0') }) -join ''
        if ($bits -notmatch '^1*0*$') { throw 'Invalid firewall netmask' }
    } else {
        $prefix = $(if ($parts.Count -eq 2) { [int]$parts[1] } else { $address.Length * 8 })
        if ($prefix -lt 0 -or $prefix -gt $address.Length * 8) { throw 'Invalid firewall prefix' }
        for ($index = 0; $index -lt $mask.Length; $index++) {
            $count = [Math]::Min(8, [Math]::Max(0, $prefix - $index * 8))
            $mask[$index] = [byte](256 - [Math]::Pow(2, 8 - $count))
        }
    }
    $network = for ($index = 0; $index -lt $address.Length; $index++) { $address[$index] -band $mask[$index] }
    return ([string]$address.Length + ':' + ($network -join '.') + '/' + ($mask -join '.'))
}
