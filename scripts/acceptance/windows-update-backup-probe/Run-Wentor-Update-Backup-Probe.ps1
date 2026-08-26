param([string]$ShellLabel = 'Unknown')

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$probeScript = Join-Path $scriptRoot 'probe-update-backup.sh'
$rcRoot = Join-Path $env:USERPROFILE 'research-claw'
$runtimeParent = Join-Path $env:LOCALAPPDATA 'Wentor\Runtimes'
$taskParent = Join-Path $env:LOCALAPPDATA 'Wentor\InstallerTemp'
$reportRoot = Join-Path $env:LOCALAPPDATA 'Wentor\ProbeReports'
$taskRoot = $null
$lines = New-Object System.Collections.Generic.List[string]
$probeExit = 1
$cleanupGreen = $false

function Add-Line([string]$Value) {
    [void]$lines.Add($Value)
}

function Find-Bash {
    if (-not (Test-Path -LiteralPath $runtimeParent -PathType Container)) { return $null }
    foreach ($directory in @(Get-ChildItem -LiteralPath $runtimeParent -Directory -Filter 'PortableGit-*' |
            Sort-Object Name -Descending)) {
        $candidate = Join-Path $directory.FullName 'bin\bash.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Convert-ToPosix([string]$WindowsPath, [string]$BashExe) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $BashExe)
    $cygpath = Join-Path $gitRoot 'usr\bin\cygpath.exe'
    if (-not (Test-Path -LiteralPath $cygpath -PathType Leaf)) {
        throw 'cygpath.exe is unavailable.'
    }
    $value = (& $cygpath -u $WindowsPath).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
        throw 'A Windows path could not be converted for Git Bash.'
    }
    return $value
}

function New-PrivateTaskRoot {
    New-Item -ItemType Directory -Force -Path $taskParent | Out-Null
    $root = Join-Path $taskParent ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $root '/inheritance:r' '/grant:r' "*${sid}:(OI)(CI)F" `
        '/grant:r' '*S-1-5-18:(OI)(CI)F' '/grant:r' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The ACL-private task root could not be created.' }
    return $root
}

try {
    Add-Line 'Wentor Windows update-backup phase probe'
    Add-Line "shell_label=$ShellLabel"
    Add-Line "powershell_edition=$($PSVersionTable.PSEdition)"
    Add-Line "powershell_version=$($PSVersionTable.PSVersion.ToString())"
    Add-Line "powershell_64bit=$([Environment]::Is64BitProcess.ToString().ToLowerInvariant())"

    if (-not (Test-Path -LiteralPath $probeScript -PathType Leaf)) {
        throw 'probe-update-backup.sh is missing.'
    }
    if (-not (Test-Path -LiteralPath $rcRoot -PathType Container)) {
        throw 'The managed Research-Claw root is unavailable.'
    }
    $bash = Find-Bash
    if (-not $bash) { throw 'The Wentor PortableGit Bash runtime is unavailable.' }

    $taskRoot = New-PrivateTaskRoot
    $taskPosix = Convert-ToPosix $taskRoot $bash
    $probePosix = Convert-ToPosix $probeScript $bash
    $rcPosix = Convert-ToPosix $rcRoot $bash

    $previousTmpDir = $env:TMPDIR
    $previousNative = $env:RC_WINDOWS_NATIVE
    try {
        $env:TMPDIR = $taskPosix
        $env:RC_WINDOWS_NATIVE = '1'
        $nativeOutput = @(& $bash '--noprofile' '--norc' $probePosix $rcPosix 2>&1 |
            ForEach-Object { [string]$_ })
        $probeExit = $LASTEXITCODE
        foreach ($line in $nativeOutput) {
            $safe = $line.Replace($rcPosix, '$RC_ROOT').Replace($taskPosix, '$TASK_ROOT')
            Add-Line $safe
        }
    } finally {
        $env:TMPDIR = $previousTmpDir
        $env:RC_WINDOWS_NATIVE = $previousNative
    }
} catch {
    Add-Line "probe_exception=$($_.Exception.Message)"
    $probeExit = 1
} finally {
    if ($taskRoot -and (Test-Path -LiteralPath $taskRoot)) {
        try {
            Remove-Item -LiteralPath $taskRoot -Recurse -Force
            $cleanupGreen = -not (Test-Path -LiteralPath $taskRoot)
        } catch {
            $cleanupGreen = $false
        }
    } else {
        $cleanupGreen = $true
    }
}

Add-Line "outer_task_cleanup=$($cleanupGreen.ToString().ToLowerInvariant())"
Add-Line "probe_exit=$probeExit"
$status = if ($probeExit -eq 0 -and $cleanupGreen) { 'PASS' } else { 'FAIL' }
Add-Line "status=$status"

$body = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
if ($body -match 'rca_[A-Za-z0-9_-]{43,}' -or
    $body -match '(^|[^A-Za-z0-9_-])sk-(proj-)?[A-Za-z0-9_-]{16,}') {
    Write-Host 'Probe output was withheld by the secret boundary.' -ForegroundColor Red
    exit 1
}

[System.IO.Directory]::CreateDirectory($reportRoot) | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$report = Join-Path $reportRoot "Wentor-Update-Backup-Probe-$ShellLabel-$stamp-$suffix.txt"
$utf8 = New-Object Text.UTF8Encoding($false)
$stream = New-Object IO.FileStream($report, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $writer = New-Object IO.StreamWriter($stream, $utf8)
    try { $writer.Write($body); $writer.Flush(); $stream.Flush($true) } finally { $writer.Dispose() }
} finally {
    $stream.Dispose()
}

foreach ($line in $lines) { Write-Host $line }
Write-Host "WENTOR_UPDATE_BACKUP_PROBE_REPORT=$report"
if ($status -eq 'PASS') { exit 0 }
exit 1
