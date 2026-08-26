Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Write-Host ''
Write-Host 'Wentor Windows Profile phase probe' -ForegroundColor Cyan
Write-Host 'This diagnostic does not read a setup token or model API key.'
Write-Host 'Live Profile access is status-only. All mutations use an isolated fake Profile.'
Write-Host 'The packaged durability fix is overlaid in probe workers only; installed files are unchanged.'
Write-Host 'No child process can wait for keyboard input.'
Write-Host ''

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$probe = Join-Path $scriptRoot 'probe-windows-profile.cjs'
$probeSha256 = '2c924f6ddf535c04c2f335e53ae8323a8912c0eb6828d6f513c483a5ab48d0e9'
$candidateRoot = Join-Path $scriptRoot 'candidate'
$candidateMaintenance = Join-Path $candidateRoot 'maintenance-lease.cjs'
$candidateStorage = Join-Path $candidateRoot 'storage.cjs'
$candidateMaintenanceSha256 = '0f3c4f21d9a99f09025a65b3d2d4d052ed7dd3817ca995667a33b8c7345380ca'
$candidateStorageSha256 = '4a7d5b7bd201547564c74c20721594a40634403d4cad4f838224d70a9b0e25bb'
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
    Write-Host 'Probe cannot start: native x64 Node.js 22 with ABI 127 was not found.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) {
    Write-Host 'Probe cannot start: probe-windows-profile.cjs is missing.' -ForegroundColor Red
    exit 1
}
if ((Get-FileHash -LiteralPath $probe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $probeSha256) {
    Write-Host 'Probe cannot start: probe-windows-profile.cjs failed its SHA256 check.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $candidateMaintenance -PathType Leaf) -or
    -not (Test-Path -LiteralPath $candidateStorage -PathType Leaf) -or
    (Get-FileHash -LiteralPath $candidateMaintenance -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateMaintenanceSha256 -or
    (Get-FileHash -LiteralPath $candidateStorage -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateStorageSha256) {
    Write-Host 'Probe cannot start: the packaged durability candidate failed its SHA256 check.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $rcRoot -PathType Container)) {
    Write-Host 'Probe cannot start: the installed Research-Claw directory was not found.' -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
& $node $probe '--rc-root' $rcRoot '--output-dir' $reportRoot '--candidate-root' $candidateRoot
$probeExit = $LASTEXITCODE

Write-Host ''
if ($probeExit -eq 0) {
    Write-Host 'Probe data capture completed. Send the newest TXT and JSON files from:' -ForegroundColor Green
    Write-Host "  $reportRoot"
    Start-Process explorer.exe -ArgumentList $reportRoot
} else {
    Write-Host "Probe stopped safely with exit code $probeExit." -ForegroundColor Red
    Write-Host "Any completed sanitized evidence is under: $reportRoot"
}
exit $probeExit
