param([Parameter(Mandatory = $true)][int]$RootPid)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($RootPid -lt 1) { throw 'RootPid must be positive.' }

if (-not ('WentorGatewayConsole' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WentorGatewayConsole {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@
}

$all = @(Get-CimInstance -ClassName Win32_Process |
    Select-Object ProcessId, ParentProcessId, Name)
$byParent = @{}
foreach ($process in $all) {
    $parent = [int]$process.ParentProcessId
    if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = @() }
    $byParent[$parent] += $process
}

$queue = New-Object Collections.Generic.Queue[int]
$queue.Enqueue($RootPid)
$seen = @{}
$tree = @()
while ($queue.Count -gt 0) {
    $pidValue = $queue.Dequeue()
    if ($seen.ContainsKey($pidValue)) { continue }
    $seen[$pidValue] = $true
    $process = $all | Where-Object { [int]$_.ProcessId -eq $pidValue } | Select-Object -First 1
    if ($process) {
        $tree += [ordered]@{
            pid = [int]$process.ProcessId
            parentPid = [int]$process.ParentProcessId
            name = [string]$process.Name
        }
    }
    if ($byParent.ContainsKey($pidValue)) {
        foreach ($child in @($byParent[$pidValue])) {
            $queue.Enqueue([int]$child.ProcessId)
        }
    }
}

$console = [ordered]@{
    attached = $false
    inputMode = $null
    quickEditEnabled = $null
    errorCode = $null
}
$attached = $false
$consoleHandle = [IntPtr]::Zero
try {
    [void][WentorGatewayConsole]::FreeConsole()
    if ([WentorGatewayConsole]::AttachConsole([uint32]$RootPid)) {
        $attached = $true
        $console.attached = $true
        [uint32]$mode = 0
        $consoleHandle = [WentorGatewayConsole]::CreateFileW(
            'CONIN$',
            [uint32]0x80000000,
            [uint32]0x00000003,
            [IntPtr]::Zero,
            [uint32]3,
            [uint32]0,
            [IntPtr]::Zero)
        if ($consoleHandle -eq [IntPtr]::Zero -or $consoleHandle -eq [IntPtr](-1)) {
            $console.errorCode = 'OPEN_CONIN_FAILED'
        } elseif ([WentorGatewayConsole]::GetConsoleMode($consoleHandle, [ref]$mode)) {
            $console.inputMode = [string]$mode
            $console.quickEditEnabled = (($mode -band 0x40) -ne 0)
        } else {
            $console.errorCode = 'GET_CONSOLE_MODE_FAILED'
        }
    } else {
        $console.errorCode = 'ATTACH_CONSOLE_FAILED'
    }
} finally {
    if ($consoleHandle -ne [IntPtr]::Zero -and $consoleHandle -ne [IntPtr](-1)) {
        [void][WentorGatewayConsole]::CloseHandle($consoleHandle)
    }
    if ($attached) { [void][WentorGatewayConsole]::FreeConsole() }
}

$gitDescendants = @($tree | Where-Object {
    $_.name -match '^(?:git|git-remote-https|git-remote-http|git-credential-manager)(?:\.exe)?$'
})
[ordered]@{
    rootPid = $RootPid
    processes = @($tree | Sort-Object pid)
    processCount = $tree.Count
    gitDescendantCount = $gitDescendants.Count
    console = $console
} | ConvertTo-Json -Depth 5 -Compress
