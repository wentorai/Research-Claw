param()

if ($args.Count -ne 0) {
    throw 'Unknown FFmpeg acceptance argument.'
}

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$FfmpegVersion = '9.0.1'
$FfmpegArchive = 'ffmpeg-release-essentials-9.0.1.7z'
$FfmpegArchiveSha256 = '49a73bdf0850092a252ac4641d922f3048d63ed113e196cc65ce1e4f7fb33e85'
$FfmpegExeSha256 = '72a489eccd008c2ec2c0a5856c5c75bc3d8bbfa90166c4566865c246445e6aa3'
$FfprobeExeSha256 = '19202b23c0043f15ad1b7bce2344f406fd52bd6efd8f995ce02e7392a1cec52f'
$SevenZipSha256 = '56b8cc9f4971cef253644fafe54063ed7fdca551d4dee0f8c6baa81b855acd72'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeAssets = Join-Path $scriptRoot 'runtime'
$archive = Join-Path $runtimeAssets $FfmpegArchive
$sevenZip = Join-Path $runtimeAssets '7zr.exe'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'Wentor\Runtimes\ffmpeg-9.0.1-49a73bdf'
$reportRoot = Join-Path $env:LOCALAPPDATA 'Wentor\ProbeReports'
$taskRoot = Join-Path $env:LOCALAPPDATA ("Wentor\InstallerTemp\ffmpeg-acceptance-{0}" -f ([Guid]::NewGuid().ToString('N')))
$editionLabel = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'Desktop5' } else { 'Core7' }
$runId = "{0}-{1}" -f (Get-Date -Format 'yyyyMMddHHmmssfff'), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$reportBase = "Wentor-FFmpeg-Test-$editionLabel-$runId"
$started = Get-Date
$steps = New-Object System.Collections.Generic.List[object]
$status = 'FAILED'
$failure = $null
$publication = 'none'

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Add-Step([string]$Name, [string]$State, [string]$Detail) {
    $steps.Add([ordered]@{
            name = $Name
            status = $State
            detail = $Detail
        })
    $color = if ($State -eq 'PASS') { 'Green' } else { 'Red' }
    Write-Host ("[{0}] {1}: {2}" -f $State, $Name, $Detail) -ForegroundColor $color
}

function Assert-FileSha([string]$Path, [string]$Expected, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing."
    }
    $actual = Get-Sha256 $Path
    if ($actual -ne $Expected) {
        throw "$Label SHA-256 mismatch."
    }
}

function Test-FfmpegRuntime([string]$Root, [string]$FixtureRoot) {
    $ffmpeg = Join-Path $Root 'bin\ffmpeg.exe'
    $ffprobe = Join-Path $Root 'bin\ffprobe.exe'
    Assert-FileSha $ffmpeg $FfmpegExeSha256 'ffmpeg.exe'
    Assert-FileSha $ffprobe $FfprobeExeSha256 'ffprobe.exe'

    $ffmpegVersion = @(& $ffmpeg '-hide_banner' '-version' 2>&1)
    if ($LASTEXITCODE -ne 0 -or $ffmpegVersion.Count -eq 0 `
        -or ([string]$ffmpegVersion[0]) -notmatch '^ffmpeg version 9\.0\.1(?:-|\s|$)') {
        throw 'ffmpeg.exe version probe failed.'
    }
    $ffprobeVersion = @(& $ffprobe '-hide_banner' '-version' 2>&1)
    if ($LASTEXITCODE -ne 0 -or $ffprobeVersion.Count -eq 0 `
        -or ([string]$ffprobeVersion[0]) -notmatch '^ffprobe version 9\.0\.1(?:-|\s|$)') {
        throw 'ffprobe.exe version probe failed.'
    }

    $fixture = Join-Path $FixtureRoot 'isolated-media-round-trip.wav'
    & $ffmpeg @(
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.10',
        '-c:a', 'pcm_s16le', '-y', $fixture
    ) 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fixture -PathType Leaf)) {
        throw 'isolated media round-trip encode failed.'
    }
    $probeOutput = @(& $ffprobe @(
        '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate',
        '-of', 'default=nw=1', $fixture
    ) 2>&1)
    if ($LASTEXITCODE -ne 0 -or $probeOutput -notcontains 'codec_name=pcm_s16le' `
        -or $probeOutput -notcontains 'sample_rate=8000') {
        throw 'isolated media round-trip probe failed.'
    }
}

function Write-Reports {
    [IO.Directory]::CreateDirectory($reportRoot) | Out-Null
    $finished = Get-Date
    $payload = [ordered]@{
        schemaVersion = 1
        status = $status
        failure = $failure
        powerShell = [ordered]@{
            edition = [string]$PSVersionTable.PSEdition
            version = [string]$PSVersionTable.PSVersion
            processArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
        }
        ffmpeg = [ordered]@{
            version = $FfmpegVersion
            archiveSha256 = $FfmpegArchiveSha256
            ffmpegExeSha256 = $FfmpegExeSha256
            ffprobeExeSha256 = $FfprobeExeSha256
            publication = $publication
        }
        startedUtc = $started.ToUniversalTime().ToString('o')
        finishedUtc = $finished.ToUniversalTime().ToString('o')
        elapsedSeconds = [Math]::Round(($finished - $started).TotalSeconds, 3)
        steps = $steps.ToArray()
    }
    $json = $payload | ConvertTo-Json -Depth 8
    $utf8 = New-Object Text.UTF8Encoding($false)
    $jsonPath = Join-Path $reportRoot "$reportBase.json"
    $txtPath = Join-Path $reportRoot "$reportBase.txt"
    [IO.File]::WriteAllText($jsonPath, "$json`r`n", $utf8)
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('Wentor Windows offline FFmpeg acceptance')
    $lines.Add("status=$status")
    $lines.Add("powershell=$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)")
    $lines.Add("ffmpeg=$FfmpegVersion")
    $lines.Add("publication=$publication")
    foreach ($step in $steps) {
        $lines.Add("[$($step.status)] $($step.name): $($step.detail)")
    }
    if ($failure) { $lines.Add("failure=$failure") }
    [IO.File]::WriteAllText($txtPath, (($lines -join "`r`n") + "`r`n"), $utf8)
    Write-Host "WENTOR_FFMPEG_REPORT=$txtPath"
    Write-Host "WENTOR_FFMPEG_JSON=$jsonPath"
}

Write-Host ''
Write-Host 'Wentor Windows offline FFmpeg acceptance' -ForegroundColor Cyan
Write-Host 'No Setup Token, model API key, WSL2, Docker, network access or keyboard input is used.'
Write-Host ''

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This acceptance runner requires native Windows.'
    }
    $validShell = ($PSVersionTable.PSEdition -eq 'Desktop' -and $PSVersionTable.PSVersion.Major -eq 5) `
        -or ($PSVersionTable.PSEdition -eq 'Core' -and $PSVersionTable.PSVersion.Major -ge 7)
    if (-not $validShell -or -not [Environment]::Is64BitOperatingSystem `
        -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'Native Windows x64 PowerShell 5.1 or 7 is required.'
    }
    Add-Step 'host.contract' 'PASS' 'native Windows x64 shell accepted'

    Assert-FileSha $archive $FfmpegArchiveSha256 'FFmpeg archive'
    Assert-FileSha $sevenZip $SevenZipSha256 '7-Zip extractor'
    Add-Step 'assets.sha256' 'PASS' 'archive and extractor matched pinned bytes'

    [IO.Directory]::CreateDirectory($taskRoot) | Out-Null
    if (Test-Path -LiteralPath $runtimeRoot) {
        Test-FfmpegRuntime $runtimeRoot $taskRoot
        $publication = 'reused-exact-runtime'
    } else {
        $extractRoot = Join-Path $taskRoot 'extract'
        & $sevenZip @('x', '-y', "-o$extractRoot", $archive) | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "FFmpeg extraction failed with exit code $LASTEXITCODE."
        }
        $source = Join-Path $extractRoot 'ffmpeg-9.0.1-essentials_build'
        Test-FfmpegRuntime $source $taskRoot
        [IO.Directory]::CreateDirectory((Split-Path -Parent $runtimeRoot)) | Out-Null
        Move-Item -LiteralPath $source -Destination $runtimeRoot
        Test-FfmpegRuntime $runtimeRoot $taskRoot
        $publication = 'installed-new-exact-runtime'
    }
    Add-Step 'runtime.publication' 'PASS' $publication
    Add-Step 'isolated media round-trip' 'PASS' 'PCM WAV encode and ffprobe readback matched'
    $status = 'PASSED'
} catch {
    $failure = $_.Exception.Message
    Add-Step 'acceptance' 'FAIL' $failure
} finally {
    if (Test-Path -LiteralPath $taskRoot) {
        Remove-Item -LiteralPath $taskRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Reports
}

if ($status -ne 'PASSED') {
    throw "FFmpeg acceptance failed: $failure"
}
