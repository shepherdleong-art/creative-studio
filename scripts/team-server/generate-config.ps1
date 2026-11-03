#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$OutputDirectory = ''
)
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $resolved = Resolve-TeamDeployment -ConfigPath $ConfigPath
    if (-not $OutputDirectory) { $OutputDirectory = [string]$resolved.serviceRoot }
    $expected = [System.IO.Path]::GetFullPath([string]$resolved.serviceRoot)
    if (-not [System.IO.Path]::GetFullPath($OutputDirectory).Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw '输出目录必须是 deploymentRoot/service'
    }
    Assert-NoReparsePoint -Path $expected
    $node = Get-TeamBootstrapNode -ConfigPath $ConfigPath
    $generator = Join-Path $PSScriptRoot 'generate-config.mjs'
    $raw = (& $node $generator --config ([System.IO.Path]::GetFullPath($ConfigPath)) --output $expected) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw '服务配置生成失败' }
    Write-TeamOperationJson -Value ($raw | ConvertFrom-Json)
    exit 0
} catch {
    [Console]::Error.WriteLine('配置生成失败：' + $_.Exception.Message)
    exit 1
}
