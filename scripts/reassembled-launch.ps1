param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [Parameter(Mandatory=$true)][string]$Uri
)
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'reassembled-launch.mjs'
# Values are native process arguments, never PowerShell source or Invoke-Expression.
# Keep the hidden protocol host alive until its desktop startup chain has exited.
& $NodePath $helper open $DataRoot $Uri
exit $LASTEXITCODE
