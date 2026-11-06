#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][ValidateSet('init-admin', 'recover-admin', 'configure-pools', 'verify-provider-budgets', 'publish-client-update')][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
)
# 以部署配置为唯一来源设置 server 运行环境，再调用包内 Node CLI；不读取源码目录或交互 PATH。
. (Join-Path $PSScriptRoot 'common.ps1')

try {
    $resolved = Resolve-TeamDeployment -ConfigPath $ConfigPath
    $script = Join-Path ([string]$resolved.releaseRoot) ('app\scripts\team-server\' + $Command + '.mjs')
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw ('当前 release 缺少运维脚本：' + $Command) }
    $node = [string]$resolved.nodeExecutable
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw '锁定 Node 运行时缺失，拒绝回退到交互 PATH' }
    $env:CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server'
    $env:CREATIVE_STUDIO_DATA_ROOT = [string]$resolved.dataRoot
    $env:CREATIVE_STUDIO_PORT = [string]$resolved.appPort
    $env:CREATIVE_STUDIO_DEPLOYMENT_ID = [string]$resolved.deploymentId
    $env:CREATIVE_STUDIO_TRUSTED_ORIGIN = [string]$resolved.origin
    $env:CREATIVE_STUDIO_SERVER_RELEASE_ID = [string]$resolved.releaseId
    if ($Arguments -and $Arguments.Count -gt 0) {
        & $node $script @Arguments
    } else {
        & $node $script
    }
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('运维命令失败：' + $_.Exception.Message)
    exit 1
}
