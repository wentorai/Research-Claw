param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][ValidateSet('Desktop', 'Core')][string]$ExpectedEdition,
    [Parameter(Mandatory = $true)][int]$ExpectedMajorVersion
)

$ErrorActionPreference = 'Stop'

if ($env:OS -cne 'Windows_NT') {
    throw 'This verifier requires native Windows.'
}
if (-not [System.Environment]::Is64BitOperatingSystem -or
    -not [System.Environment]::Is64BitProcess) {
    throw 'This verifier requires a 64-bit Windows process and OS.'
}
$processorArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
if ($processorArchitecture -cne 'AMD64') {
    throw "Expected AMD64 process architecture; observed $processorArchitecture."
}
$processors = @(Get-CimInstance Win32_Processor -ErrorAction Stop)
if ($processors.Count -lt 1 -or @($processors | Where-Object { $_.Architecture -ne 9 }).Count -ne 0) {
    throw 'This verifier requires an x64 Windows processor contract.'
}
if ($PSVersionTable.PSEdition -cne $ExpectedEdition) {
    throw "PowerShell edition mismatch: expected $ExpectedEdition."
}
if ($PSVersionTable.PSVersion.Major -ne $ExpectedMajorVersion) {
    throw "PowerShell major version mismatch: expected $ExpectedMajorVersion."
}

$resolved = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
if (-not $item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    $bytes = [System.IO.File]::ReadAllBytes($resolved)
} else {
    throw 'Installer must be a regular non-reparse file.'
}
if ($bytes.Length -le 3 -or
    $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
    throw 'Native Windows installer must be UTF-8 with BOM.'
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false, $true)
$installerText = $utf8NoBom.GetString($bytes, 3, $bytes.Length - 3)
if ($installerText.IndexOf([char]0xFFFD) -ge 0) {
    throw 'Native Windows installer contains a replacement character.'
}
$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(
    $installerText,
    $resolved,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    $messages = @($parseErrors | ForEach-Object { $_.Message }) -join ' | '
    throw "Native Windows installer parse failed: $messages"
}

$algorithm = [System.Security.Cryptography.SHA256]::Create()
try {
    $sha256 = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
} finally {
    $algorithm.Dispose()
}

[ordered]@{
    ok = $true
    osArchitecture = 'x64'
    processArchitecture = $processorArchitecture
    powerShellEdition = [string]$PSVersionTable.PSEdition
    powerShellVersion = [string]$PSVersionTable.PSVersion
    utf8Bom = $true
    parseErrors = 0
    installerSha256 = $sha256
} | ConvertTo-Json -Compress
