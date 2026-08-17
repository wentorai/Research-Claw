Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Write-Host ''
Write-Host 'Wentor Windows native UX read-only capture' -ForegroundColor Cyan
Write-Host 'This observes an already running Research-Claw instance.'
Write-Host 'It does not install, update, stop, or reconfigure Research-Claw.'
Write-Host 'No keyboard input is required.'
Write-Host ''

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$capture = Join-Path $scriptRoot 'capture-windows-native-ux.cjs'
$hostSnapshot = Join-Path $scriptRoot 'Capture-Wentor-UX-Host.ps1'
$rcRoot = Join-Path $env:USERPROFILE 'research-claw'
$reportRoot = Join-Path $env:LOCALAPPDATA 'Wentor\ProbeReports'
$runtimeParent = Join-Path $env:LOCALAPPDATA 'Wentor\Runtimes'

$nodeCandidates = @()
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
        $nodeVersion = (& $candidate -p process.versions.node).Trim()
        if ($LASTEXITCODE -ne 0) { continue }
        $nodeAbi = (& $candidate -p process.versions.modules).Trim()
        if ($LASTEXITCODE -ne 0) { continue }
        $nodeArch = (& $candidate -p process.arch).Trim()
        if ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^22\.' -and $nodeAbi -eq '127' -and $nodeArch -eq 'x64') {
            $node = $candidate
            break
        }
    } catch {
        continue
    }
}

if (-not $node) {
    Write-Host 'Capture cannot start: Wentor Node 22 x64 ABI 127 was not found.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $capture -PathType Leaf)) {
    Write-Host 'Capture cannot start: capture-windows-native-ux.cjs is missing.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $hostSnapshot -PathType Leaf)) {
    Write-Host 'Capture cannot start: Capture-Wentor-UX-Host.ps1 is missing.' -ForegroundColor Red
    exit 1
}

[System.IO.Directory]::CreateDirectory($reportRoot) | Out-Null
& $node $capture '--rc-root' $rcRoot '--output-dir' $reportRoot '--host-script' $hostSnapshot
$captureExit = $LASTEXITCODE

Write-Host ''
if ($captureExit -eq 0) {
    Write-Host 'Capture passed. Send the newest Wentor-UX-Capture TXT and JSON files.' -ForegroundColor Green
    Start-Process explorer.exe -ArgumentList $reportRoot
} else {
    Write-Host "Capture finished with exit code $captureExit. Send the newest sanitized reports." -ForegroundColor Red
    if (Test-Path -LiteralPath $reportRoot -PathType Container) {
        Start-Process explorer.exe -ArgumentList $reportRoot
    }
}
exit $captureExit
