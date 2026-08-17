param(
    [Parameter(Mandatory = $true)]
    [string]$RcRoot,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^http://127[.]0[.]0[.]1:28789/$')]
    [string]$DashboardUrl,
    [switch]$DispatchBrowser
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-UtcCreationTime {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [DateTime]) { return $Value.ToUniversalTime().ToString('o') }
    try {
        return ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$Value)).ToUniversalTime().ToString('o')
    } catch {
        return $null
    }
}

$listener = [ordered]@{
    unique = $false
    pid = $null
    parentPid = $null
    creationTimeUtc = $null
    executableName = $null
    commandLineContainsRcRoot = $null
    executableUnderWentorRuntime = $null
    errorCode = $null
}

try {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort 28789 -ErrorAction Stop)
    $listenerPids = @($connections | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
    if ($listenerPids.Count -eq 0) {
        $listener.errorCode = 'LISTENER_NOT_FOUND'
    } elseif ($listenerPids.Count -ne 1) {
        $listener.errorCode = 'LISTENER_NOT_UNIQUE'
    } else {
        $processId = [int]$listenerPids[0]
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
        if ($null -eq $process) { throw 'PROCESS_NOT_FOUND' }
        $observedProcessText = [string]$process.CommandLine
        $executablePath = [string]$process.ExecutablePath
        $fullRcRoot = [System.IO.Path]::GetFullPath($RcRoot).TrimEnd('\')
        $rcRootForward = $fullRcRoot.Replace('\', '/')
        $runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Wentor\Runtimes')).TrimEnd('\')
        $listener.unique = $true
        $listener.pid = $processId
        $listener.parentPid = [int]$process.ParentProcessId
        $listener.creationTimeUtc = Get-UtcCreationTime $process.CreationDate
        $listener.executableName = [System.IO.Path]::GetFileName($executablePath)
        $listener.commandLineContainsRcRoot = (
            $observedProcessText.IndexOf($fullRcRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $observedProcessText.IndexOf($rcRootForward, [StringComparison]::OrdinalIgnoreCase) -ge 0
        )
        $listener.executableUnderWentorRuntime = (
            $executablePath.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)
        )
    }
} catch {
    $listener.errorCode = $_.Exception.GetType().Name
}

$browserDispatch = [ordered]@{
    attempted = [bool]$DispatchBrowser
    dispatchAccepted = $false
    errorCode = $null
}
if ($DispatchBrowser) {
    try {
        Start-Process -FilePath $DashboardUrl -ErrorAction Stop
        $browserDispatch.dispatchAccepted = $true
    } catch {
        $browserDispatch.errorCode = $_.Exception.GetType().Name
    }
}

$snapshot = [ordered]@{
    powershell = [ordered]@{
        edition = [string]$PSVersionTable.PSEdition
        major = [int]$PSVersionTable.PSVersion.Major
        minor = [int]$PSVersionTable.PSVersion.Minor
        is64BitOperatingSystem = [Environment]::Is64BitOperatingSystem
        is64BitProcess = [Environment]::Is64BitProcess
        processorArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
    }
    listener = $listener
    browserDispatch = $browserDispatch
}

$snapshot | ConvertTo-Json -Depth 6 -Compress
