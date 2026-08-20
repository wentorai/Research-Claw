param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Desktop5', 'Core7')]
    [string]$EditionLabel,

    [Parameter(Mandatory = $true)]
    [string]$RunnerPath,

    [Parameter(Mandatory = $true)]
    [string]$LogPath
)

if ($args.Count -ne 0) {
    throw 'Unknown FFmpeg bootstrap argument.'
}

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$exitCode = 1
$transcriptStarted = $false
$safeFailure = $null
$utf8 = New-Object Text.UTF8Encoding($false)

try {
    $reportRoot = Split-Path -Parent $LogPath
    [IO.Directory]::CreateDirectory($reportRoot) | Out-Null
    [IO.File]::WriteAllText(
        $LogPath,
        "Wentor FFmpeg bootstrap`r`nedition=$EditionLabel`r`nstatus=STARTED`r`n",
        $utf8
    )
    Start-Transcript -LiteralPath $LogPath -Append -Force | Out-Null
    $transcriptStarted = $true

    if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) {
        throw 'The FFmpeg acceptance runner is missing.'
    }

    & $RunnerPath
    $exitCode = 0
} catch {
    $safeFailure = $_.Exception.Message
    Write-Host "[FAIL] FFmpeg $EditionLabel acceptance: $safeFailure" -ForegroundColor Red
} finally {
    if ($transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch { }
    }
    try {
        $finalStatus = if ($exitCode -eq 0) { 'PASSED' } else { 'FAILED' }
        [IO.File]::AppendAllText(
            $LogPath,
            "status=$finalStatus`r`n",
            $utf8
        )
    } catch { }
    Write-Host "WENTOR_FFMPEG_BOOTSTRAP_LOG=$LogPath"
}

exit $exitCode
