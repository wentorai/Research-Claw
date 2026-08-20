Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$probe = Join-Path $scriptRoot 'probe-windows-model-classifier.cjs'
$helper = Join-Path $scriptRoot 'model-probe.cjs'
$probeSha256 = '7a8355b04b332bed26b1ac7694805f68a9b2a9dbc830295315e522c04e538d8d'
$helperSha256 = 'f359f2c5e7443d60653541c252f091c03b1f93a6c1897e51017e024a1f67c7c7'
$rcRoot = Join-Path $env:USERPROFILE 'research-claw'
$reportRoot = Join-Path $env:LOCALAPPDATA 'Wentor\ProbeReports'

Write-Host ''
Write-Host 'Wentor v20 model classifier probe' -ForegroundColor Cyan
Write-Host 'This diagnostic does not reinstall or modify Research-Claw.'
Write-Host 'It never prints the Setup Token, model credential, or raw provider error.'
Write-Host ''

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
        $nodeContract = (& $candidate -p "[process.versions.node,process.versions.modules,process.arch].join('|')").Trim()
        if ($LASTEXITCODE -eq 0 -and $nodeContract -match '^22\.[^|]+\|127\|x64$') {
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
foreach ($item in @(
    @{ Path = $probe; Sha = $probeSha256; Label = 'classifier' },
    @{ Path = $helper; Sha = $helperSha256; Label = 'model helper' }
)) {
    if (-not (Test-Path -LiteralPath $item.Path -PathType Leaf) -or
        (Get-FileHash -LiteralPath $item.Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.Sha) {
        Write-Host "Probe cannot start: packaged $($item.Label) failed its SHA256 check." -ForegroundColor Red
        exit 1
    }
}
if (-not (Test-Path -LiteralPath $rcRoot -PathType Container)) {
    Write-Host 'Probe cannot start: the installed Research-Claw directory was not found.' -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
& $node $probe '--rc-root' $rcRoot '--output-dir' $reportRoot '--helper' $helper
$probeExit = $LASTEXITCODE

Write-Host ''
if ($probeExit -eq 0) {
    Write-Host 'Diagnostic capture completed. Send the newest TXT and JSON reports from:' -ForegroundColor Green
    Write-Host "  $reportRoot"
    Start-Process explorer.exe -ArgumentList $reportRoot
} else {
    Write-Host "Probe stopped safely with exit code $probeExit." -ForegroundColor Red
}
exit $probeExit
