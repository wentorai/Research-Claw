# Executes the production Windows updater against deterministic git/node
# processes. This is intentionally a real pwsh subprocess test: source-text
# assertions cannot prove that $LASTEXITCODE and ErrorActionPreference interact
# correctly.
$ErrorActionPreference = 'Stop'

$UpdaterSource = Join-Path $PSScriptRoot 'update-research-claw.ps1'
$PwshPath = (Get-Process -Id $PID).Path

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Set-Executable {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not $IsWindows) {
        & chmod +x $Path
        if ($LASTEXITCODE -ne 0) {
            throw "chmod failed for $Path"
        }
    }
}

function New-UpdaterFixture {
    param([Parameter(Mandatory = $true)][string]$Name)

    $Root = Join-Path ([IO.Path]::GetTempPath()) (
        "rc-pwsh-update-{0}-{1}" -f $Name, [Guid]::NewGuid().ToString('N')
    )
    $null = New-Item -ItemType Directory -Path (Join-Path $Root '.git') -Force
    $null = New-Item -ItemType Directory -Path (Join-Path $Root 'scripts') -Force
    $null = New-Item -ItemType Directory -Path (Join-Path $Root 'bin') -Force
    $null = New-Item -ItemType Directory -Path (Join-Path $Root 'home') -Force
    Copy-Item $UpdaterSource (Join-Path $Root 'scripts' 'update-research-claw.ps1')

    if ($IsWindows) {
        $GitPath = Join-Path $Root 'bin' 'git.cmd'
        $NodePath = Join-Path $Root 'bin' 'node.cmd'
        $PinnedNodePath = Join-Path $Root 'bin' 'node22.cmd'
        Set-Content -Path $GitPath -Encoding Ascii -Value @'
@echo off
if "%1"=="rev-parse" (echo deadbeef& exit /b 0)
if "%1"=="pull" exit /b %FAKE_PULL_EXIT%
if "%1"=="remote" exit /b 0
if "%1"=="fetch" exit /b %FAKE_FETCH_EXIT%
if "%1"=="merge" exit /b %FAKE_MERGE_EXIT%
exit /b 0
'@
        Set-Content -Path $NodePath -Encoding Ascii -Value @'
@echo off
echo %*>>"%NODE_CALLS%"
if "%2"=="resolve" echo %PINNED_NODE_JSON%
exit /b 0
'@
        Set-Content -Path $PinnedNodePath -Encoding Ascii -Value @'
@echo off
echo PINNED %*>>"%NODE_CALLS%"
exit /b 0
'@
    } else {
        $GitPath = Join-Path $Root 'bin' 'git'
        $NodePath = Join-Path $Root 'bin' 'node'
        $PinnedNodePath = Join-Path $Root 'bin' 'node22'
        Set-Content -Path $GitPath -NoNewline -Value @'
#!/bin/sh
case "$1" in
  rev-parse) printf '%s\n' deadbeef; exit 0 ;;
  pull) exit "${FAKE_PULL_EXIT:-0}" ;;
  remote) exit 0 ;;
  fetch) exit "${FAKE_FETCH_EXIT:-0}" ;;
  merge) exit "${FAKE_MERGE_EXIT:-0}" ;;
esac
exit 0
'@
        Set-Content -Path $NodePath -NoNewline -Value @'
#!/bin/sh
printf '%s\n' "$*" >> "$NODE_CALLS"
case "$*" in
  *"node-runtime.cjs resolve"*) printf '{"path":"%s","version":"22.22.2","abi":"127","arch":"x64"}\n' "$PINNED_NODE" ;;
esac
exit 0
'@
        Set-Content -Path $PinnedNodePath -NoNewline -Value @'
#!/bin/sh
printf 'PINNED %s\n' "$*" >> "$NODE_CALLS"
exit 0
'@
        Set-Executable $GitPath
        Set-Executable $NodePath
        Set-Executable $PinnedNodePath
    }

    return $Root
}

function Invoke-UpdaterScenario {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$PullExit,
        [Parameter(Mandatory = $true)][int]$FetchExit,
        [Parameter(Mandatory = $true)][int]$MergeExit
    )

    $Root = New-UpdaterFixture $Name
    $NodeCallsPath = Join-Path $Root 'node-calls.log'
    $SavedEnvironment = @{
        PATH = $env:PATH
        HOME = $env:HOME
        USERPROFILE = $env:USERPROFILE
        NODE_CALLS = $env:NODE_CALLS
        FAKE_PULL_EXIT = $env:FAKE_PULL_EXIT
        FAKE_FETCH_EXIT = $env:FAKE_FETCH_EXIT
        FAKE_MERGE_EXIT = $env:FAKE_MERGE_EXIT
        PINNED_NODE = $env:PINNED_NODE
        PINNED_NODE_JSON = $env:PINNED_NODE_JSON
    }

    try {
        $env:PATH = (Join-Path $Root 'bin') + [IO.Path]::PathSeparator + $SavedEnvironment.PATH
        $env:HOME = Join-Path $Root 'home'
        $env:USERPROFILE = Join-Path $Root 'home'
        $env:NODE_CALLS = $NodeCallsPath
        $env:FAKE_PULL_EXIT = [string]$PullExit
        $env:FAKE_FETCH_EXIT = [string]$FetchExit
        $env:FAKE_MERGE_EXIT = [string]$MergeExit
        $PinnedNodePath = if ($IsWindows) {
            Join-Path $Root 'bin' 'node22.cmd'
        } else {
            Join-Path $Root 'bin' 'node22'
        }
        $env:PINNED_NODE = $PinnedNodePath
        $env:PINNED_NODE_JSON = (@{
            path = $PinnedNodePath
            version = '22.22.2'
            abi = '127'
            arch = 'x64'
        } | ConvertTo-Json -Compress)

        $RawOutput = & $PwshPath -NoLogo -NoProfile -File (
            Join-Path $Root 'scripts' 'update-research-claw.ps1'
        ) 2>&1 | Out-String
        $ExitCode = $LASTEXITCODE
        $Output = (
            ($RawOutput -replace "$([char]27)\[[0-9;]*m", ' ') -replace '\s+', ' '
        ).Trim()
        $NodeCalls = if (Test-Path $NodeCallsPath) {
            Get-Content $NodeCallsPath -Raw
        } else {
            ''
        }

        return [PSCustomObject]@{
            Name = $Name
            ExitCode = $ExitCode
            Output = $Output
            NodeCalls = $NodeCalls
        }
    } finally {
        foreach ($Key in $SavedEnvironment.Keys) {
            $Value = $SavedEnvironment[$Key]
            if ($null -eq $Value) {
                Remove-Item "Env:$Key" -ErrorAction SilentlyContinue
            } else {
                Set-Item "Env:$Key" $Value
            }
        }
        Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
    }
}

$DoubleFailure = Invoke-UpdaterScenario 'double-failure' 17 18 0
Assert-True ($DoubleFailure.ExitCode -ne 0) 'double remote failure returned success'
Assert-True (
    $DoubleFailure.Output -match 'neither origin nor GitHub.*could be checked'
) "double remote failure was not observable:`n$($DoubleFailure.Output)"
Assert-True (
    [string]::IsNullOrWhiteSpace($DoubleFailure.NodeCalls)
) 'double remote failure continued into install/build'

$MergeFailure = Invoke-UpdaterScenario 'merge-failure' 17 0 19
Assert-True ($MergeFailure.ExitCode -ne 0) 'GitHub merge failure returned success'
Assert-True (
    $MergeFailure.Output -match 'could not be.*fast-forwarded'
) "GitHub merge failure was not observable:`n$($MergeFailure.Output)"
Assert-True (
    [string]::IsNullOrWhiteSpace($MergeFailure.NodeCalls)
) 'GitHub merge failure continued into install/build'

$OriginOnly = Invoke-UpdaterScenario 'origin-only' 0 18 0
Assert-True ($OriginOnly.ExitCode -eq 0) 'successful origin check was rejected'
Assert-True (
    $OriginOnly.Output -match 'Origin was checked successfully'
) 'origin-only degraded state was not disclosed'
Assert-True (
    $OriginOnly.Output -match '\[update-research-claw\] Done\.'
) 'origin-only success did not reach the completion message'
Assert-True (
    $OriginOnly.NodeCalls -match 'run-pnpm\.cjs install'
) 'origin-only success skipped dependency installation'
Assert-True (
    $OriginOnly.NodeCalls -match 'run-pnpm\.cjs build'
) 'origin-only success skipped the build'
Assert-True (
    $OriginOnly.NodeCalls -match 'PINNED .*native-runtime-guard\.cjs'
) 'origin-only success skipped pinned native runtime verification'

Write-Output (@{
    ok = $true
    scenarios = @(
        @{ name = $DoubleFailure.Name; exitCode = $DoubleFailure.ExitCode }
        @{ name = $MergeFailure.Name; exitCode = $MergeFailure.ExitCode }
        @{ name = $OriginOnly.Name; exitCode = $OriginOnly.ExitCode }
    )
} | ConvertTo-Json -Depth 4)
