Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Write-Host ''
Write-Host 'Wentor Windows Native full-chain probe' -ForegroundColor Cyan
Write-Host 'This is a diagnostic run. It will not reinstall Research-Claw.'
Write-Host 'It does not read a setup token or model API key.'
Write-Host 'The network/plugin and isolated test stages may take 10-20 minutes.'
Write-Host ''

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$probe = Join-Path $scriptRoot 'probe-windows-native.cjs'
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
    Write-Host 'Probe cannot start: a native x64 Node.js 22 runtime with ABI 127 was not found.' -ForegroundColor Red
    Write-Host 'Keep this window open and send this non-secret message to Wentor.'
    exit 1
}
if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) {
    Write-Host 'Probe cannot start: probe-windows-native.cjs is missing.' -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
& $node $probe '--rc-root' $rcRoot '--output-dir' $reportRoot
$probeExit = $LASTEXITCODE

Write-Host ''
if ($probeExit -eq 0) {
    Write-Host 'Probe finished. Send the newest TXT and JSON files from:' -ForegroundColor Green
    Write-Host "  $reportRoot"
    Start-Process explorer.exe -ArgumentList $reportRoot
} else {
    Write-Host "Probe stopped safely with exit code $probeExit." -ForegroundColor Red
    Write-Host "Any completed sanitized evidence is under: $reportRoot"
}
exit $probeExit
