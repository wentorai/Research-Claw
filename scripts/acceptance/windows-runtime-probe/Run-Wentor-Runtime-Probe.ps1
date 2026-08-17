Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Write-Host ''
Write-Host 'Wentor Windows post-install runtime probe' -ForegroundColor Cyan
Write-Host 'Keep the Research-Claw gateway running. Do not press Enter or click its console.'
Write-Host 'This probe reads no Setup Token or model API key and changes no Profile data.'
Write-Host 'The authenticated config response is discarded in memory and never reported.'
Write-Host 'Expected duration: about two minutes.'
Write-Host ''

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$probe = Join-Path $scriptRoot 'probe-windows-runtime.cjs'
$probeSha256 = '9077d1b6a407b9606882a1648375430a5293fe0b7b20e5370d3812711007029e'
$processHelper = Join-Path $scriptRoot 'Inspect-Wentor-Gateway.ps1'
$processHelperSha256 = '01424ebd0a65d3acf6b116ffc27c5cf1d83cfac4b18c7c7d85c02a64974cd00e'
$rcRoot = Join-Path $env:USERPROFILE 'research-claw'
$reportRoot = Join-Path $env:LOCALAPPDATA 'Wentor\ProbeReports'

$nodeCandidates = @()
$runtimeParent = Join-Path $env:LOCALAPPDATA 'Wentor\Runtimes'
if (Test-Path -LiteralPath $runtimeParent -PathType Container) {
    $nodeCandidates += @(Get-ChildItem -LiteralPath $runtimeParent -Directory -Filter 'node-v22*' |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'node.exe' })
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }

$node = $null
foreach ($candidate in @($nodeCandidates | Select-Object -Unique)) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        $version = (& $candidate -p process.versions.node).Trim()
        $abi = (& $candidate -p process.versions.modules).Trim()
        $arch = (& $candidate -p process.arch).Trim()
        if ($LASTEXITCODE -eq 0 -and $version -match '^22\.' -and $abi -eq '127' -and $arch -eq 'x64') {
            $node = $candidate
            break
        }
    } catch {
        continue
    }
}

if (-not $node) {
    Write-Host 'Probe cannot start: native x64 Node.js 22 with ABI 127 was not found.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) {
    Write-Host 'Probe cannot start: probe-windows-runtime.cjs is missing.' -ForegroundColor Red
    exit 1
}
if ((Get-FileHash -LiteralPath $probe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $probeSha256) {
    Write-Host 'Probe cannot start: probe-windows-runtime.cjs failed its SHA256 check.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $processHelper -PathType Leaf) `
    -or (Get-FileHash -LiteralPath $processHelper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $processHelperSha256) {
    Write-Host 'Probe cannot start: Inspect-Wentor-Gateway.ps1 failed its SHA256 check.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $rcRoot -PathType Container)) {
    Write-Host 'Probe cannot start: the installed Research-Claw directory was not found.' -ForegroundColor Red
    exit 1
}

$consoleInputMode = 'unavailable'
$quickEdit = 'unknown'
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WentorConsoleMode {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
}
'@
    [uint32]$mode = 0
    $handle = [WentorConsoleMode]::GetStdHandle(-10)
    if ([WentorConsoleMode]::GetConsoleMode($handle, [ref]$mode)) {
        $consoleInputMode = [string]$mode
        $quickEdit = if (($mode -band 0x40) -ne 0) { 'true' } else { 'false' }
    }
} catch {
    $consoleInputMode = 'unavailable'
    $quickEdit = 'unknown'
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
& $node $probe '--rc-root' $rcRoot '--output-dir' $reportRoot `
    '--console-input-mode' $consoleInputMode '--quick-edit' $quickEdit `
    '--expected-head' '__EXPECTED_HEAD__' '--process-helper' $processHelper
$probeExit = $LASTEXITCODE

Write-Host ''
if ($probeExit -eq 0) {
    Write-Host 'Diagnostic capture completed. The report folder will open now.' -ForegroundColor Green
    Start-Process explorer.exe -ArgumentList $reportRoot
} else {
    Write-Host "Probe infrastructure stopped with exit code $probeExit." -ForegroundColor Red
    Write-Host "Any completed sanitized evidence is under: $reportRoot"
}
exit $probeExit
