param(
    [string]$InstallerPath = (Join-Path $PSScriptRoot 'install-docker.ps1'),
    [Parameter(Mandatory = $true)]
    [ValidateSet('Desktop', 'Core')]
    [string]$ExpectedEdition,
    [Parameter(Mandatory = $true)]
    [ValidateSet(5, 7)]
    [int]$ExpectedMajorVersion,
    [string]$AcceptanceHarnessPath = (
        Join-Path $PSScriptRoot 'acceptance/windows-bootstrap-docker.ps1'
    )
)

$ErrorActionPreference = 'Stop'

function Assert-Contract {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

function Get-BytesSha256Hex([byte[]]$Bytes) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

$isWindowsHost = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
Assert-Contract $isWindowsHost 'This contract probe must run on Windows.'
Assert-Contract ([System.Environment]::Is64BitOperatingSystem) 'Windows x64 is required.'
Assert-Contract ([System.Environment]::Is64BitProcess) 'A Windows x64 PowerShell process is required.'
$processorArchitecture = [System.Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE')
Assert-Contract ($processorArchitecture -ceq 'AMD64') 'Native Windows AMD64 is required.'
$processors = @(Get-CimInstance Win32_Processor -ErrorAction Stop)
Assert-Contract ($processors.Count -gt 0) 'Windows processor evidence is unavailable.'
Assert-Contract (@($processors | Where-Object {
            [int]$_.Architecture -ne 9 -or [int]$_.AddressWidth -ne 64 -or
            [int]$_.DataWidth -ne 64
        }).Count -eq 0) 'Native Windows x64 processor evidence is required.'
Assert-Contract ($PSVersionTable.PSEdition -ceq $ExpectedEdition) (
    'The PowerShell edition did not match the workflow contract.'
)
Assert-Contract ($PSVersionTable.PSVersion.Major -eq $ExpectedMajorVersion) (
    'The PowerShell major version did not match the workflow contract.'
)
if ($ExpectedEdition -ceq 'Desktop') {
    Assert-Contract (
        $ExpectedMajorVersion -eq 5 -and
        $PSVersionTable.PSVersion.Major -eq 5 -and
        $PSVersionTable.PSVersion.Minor -eq 1
    ) 'Windows PowerShell 5.1 is required for the Desktop contract.'
} else {
    Assert-Contract ($ExpectedMajorVersion -eq 7) (
        'PowerShell 7 is required for the Core contract.'
    )
}
Assert-Contract (Test-Path -LiteralPath $InstallerPath -PathType Leaf) 'Installer not found.'
$InstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)
Assert-Contract (
    (Test-Path -LiteralPath $AcceptanceHarnessPath -PathType Leaf)
) 'Acceptance harness not found.'
$AcceptanceHarnessPath = [System.IO.Path]::GetFullPath($AcceptanceHarnessPath)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false, $true)
$installerBytes = [System.IO.File]::ReadAllBytes($InstallerPath)
try {
    $installerText = $utf8NoBom.GetString($installerBytes)
} catch {
    throw 'The installer is not strict UTF-8.'
}
Assert-Contract ($installerText.IndexOf([char]0) -lt 0) 'The installer contains a NUL byte.'
$installerSha256 = Get-BytesSha256Hex $installerBytes
$installerBase64 = [Convert]::ToBase64String($installerBytes)
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput(
    $installerText,
    [ref]$tokens,
    [ref]$parseErrors
)
Assert-Contract ($parseErrors.Count -eq 0) 'The installer did not parse in this PowerShell edition.'
$parameterNames = @($ast.ParamBlock.Parameters | ForEach-Object {
    $_.Name.VariablePath.UserPath
})
Assert-Contract (
    $parameterNames.Count -eq 1 -and $parameterNames[0] -eq 'AuthToken'
) 'The installer top-level parameter ABI drifted.'

$acceptanceBytes = [System.IO.File]::ReadAllBytes($AcceptanceHarnessPath)
try {
    $acceptanceText = $utf8NoBom.GetString($acceptanceBytes)
} catch {
    throw 'The acceptance harness is not strict UTF-8.'
}
Assert-Contract ($acceptanceText.IndexOf([char]0) -lt 0) (
    'The acceptance harness contains a NUL byte.'
)
$acceptanceHarnessSha256 = Get-BytesSha256Hex $acceptanceBytes
$acceptanceTokens = $null
$acceptanceParseErrors = $null
$acceptanceAst = [System.Management.Automation.Language.Parser]::ParseInput(
    $acceptanceText,
    [ref]$acceptanceTokens,
    [ref]$acceptanceParseErrors
)
Assert-Contract ($acceptanceParseErrors.Count -eq 0) (
    'The acceptance harness did not parse in this PowerShell edition.'
)
$acceptanceParameterNames = @($acceptanceAst.ParamBlock.Parameters | ForEach-Object {
    $_.Name.VariablePath.UserPath
})
$expectedAcceptanceParameterNames = @(
    'ManifestPath', 'SecretBundlePath', 'EvidenceDirectory',
    'InstallerPath', 'DisposableHostConfirmed'
)
Assert-Contract (
    ($acceptanceParameterNames -join "`n") -ceq
        ($expectedAcceptanceParameterNames -join "`n")
) 'The acceptance harness top-level parameter ABI drifted.'

$scopeProbe = [scriptblock]::Create(@'
param([string]$AuthToken)
& {
    Set-Variable -Name AuthToken -Scope 1 -Value $null
    $parentBoundParameters = Get-Variable -Name PSBoundParameters -Scope 1 -ValueOnly
    if ($parentBoundParameters -and $parentBoundParameters.ContainsKey('AuthToken')) {
        [void]$parentBoundParameters.Remove('AuthToken')
    }
}
[ordered]@{
    tokenCleared = [string]::IsNullOrEmpty($AuthToken)
    bindingRemoved = -not $PSBoundParameters.ContainsKey('AuthToken')
}
'@)
$scopeResult = & $scopeProbe -AuthToken ('rca_' + ('A' * 43))
Assert-Contract ($scopeResult.tokenCleared) 'The dynamic scriptblock Token scope was not cleared.'
Assert-Contract ($scopeResult.bindingRemoved) 'The dynamic scriptblock Token binding was not removed.'

$root = Join-Path ([System.IO.Path]::GetTempPath()) (
    'rc-powershell-installer-contract.' + [guid]::NewGuid().ToString('N')
)
$emptyPath = Join-Path $root 'empty-path'
$childTemp = Join-Path $root 'child-temp'
$wrapper = Join-Path $root 'invoke-installer.ps1'
$stdout = Join-Path $root 'stdout.log'
$stderr = Join-Path $root 'stderr.log'
$shellPath = (Get-Process -Id $PID).Path
$savedPath = $env:PATH
$savedTemp = $env:TEMP
$savedTmp = $env:TMP

try {
    $null = New-Item -ItemType Directory -Path $emptyPath, $childTemp -Force
    Set-Content -LiteralPath $wrapper -Encoding UTF8 -Value @"
param([string]`$Mode)
`$ErrorActionPreference = 'Stop'
`$utf8NoBom = New-Object System.Text.UTF8Encoding(`$false, `$true)
`$installerBytes = [Convert]::FromBase64String('$installerBase64')
`$installerText = `$utf8NoBom.GetString(`$installerBytes)
if (`$installerText.IndexOf([char]0) -ge 0) { throw 'Installer snapshot contains a NUL byte.' }
`$installerScriptBlock = [scriptblock]::Create(`$installerText)
[Array]::Clear(`$installerBytes, 0, `$installerBytes.Length)
`$installerText = `$null
try {
    switch (`$Mode) {
        'no-docker' { & `$installerScriptBlock }
        'empty-token' { `$empty = ''; & `$installerScriptBlock -AuthToken `$empty }
        'invalid-token' { & `$installerScriptBlock -AuthToken 'not-a-bootstrap-token' }
        'missing-value' { & `$installerScriptBlock -AuthToken }
        'valid-token-no-docker' {
            `$valid = 'rca_' + ('A' * 43)
            & `$installerScriptBlock -AuthToken `$valid
        }
        'unknown-parameter' { & `$installerScriptBlock -UnknownParameter 'value' }
        'duplicate-token' {
            & `$installerScriptBlock -AuthToken 'first' -AuthToken 'second'
        }
        default { throw 'Unknown contract scenario.' }
    }
} catch {
    [Console]::Error.WriteLine(('RC_CONTRACT_ERROR_ID={0}' -f `$_.FullyQualifiedErrorId))
    [Console]::Error.WriteLine(('RC_CONTRACT_MESSAGE={0}' -f `$_.Exception.Message))
    exit 86
}
"@

    $env:PATH = $emptyPath
    $env:TEMP = $childTemp
    $env:TMP = $childTemp
    $results = @()
    $contracts = @(
        [ordered]@{
            name = 'no-docker'
            expectedMarker = 'Docker is unavailable.'
            forbidDockerUnavailable = $false
        },
        [ordered]@{
            name = 'empty-token'
            expectedMarker = '-AuthToken requires a non-empty value.'
            forbidDockerUnavailable = $true
        },
        [ordered]@{
            name = 'invalid-token'
            expectedMarker = '-AuthToken has an invalid format.'
            forbidDockerUnavailable = $true
        },
        [ordered]@{
            name = 'missing-value'
            expectedMarker = 'RC_CONTRACT_ERROR_ID=MissingArgument'
            forbidDockerUnavailable = $true
        },
        [ordered]@{
            name = 'valid-token-no-docker'
            expectedMarker = 'Docker is unavailable.'
            forbidDockerUnavailable = $false
        },
        [ordered]@{
            name = 'unknown-parameter'
            expectedMarker = 'Unknown or extra installer arguments are not supported.'
            forbidDockerUnavailable = $true
        },
        [ordered]@{
            name = 'duplicate-token'
            expectedMarker = 'RC_CONTRACT_ERROR_ID=ParameterAlreadyBound'
            forbidDockerUnavailable = $true
        }
    )
    foreach ($contract in $contracts) {
        $mode = [string]$contract.name
        Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
        $argumentLine = (
            '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode {1}' -f
            $wrapper, $mode
        )
        $process = Start-Process -FilePath $shellPath -ArgumentList $argumentLine `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
            -NoNewWindow -Wait -PassThru
        $output = (
            (Get-Content -LiteralPath $stdout, $stderr -Raw -ErrorAction SilentlyContinue) -join "`n"
        )
        Assert-Contract ($process.ExitCode -ne 0) "$mode returned success."
        Assert-Contract ($output.Contains([string]$contract.expectedMarker)) (
            "$mode failed for the wrong reason."
        )
        if ([bool]$contract.forbidDockerUnavailable) {
            Assert-Contract ($output -notmatch 'Docker is unavailable') (
                "$mode fell through to Docker preflight."
            )
        }
        Assert-Contract ($output -notmatch 'rca_[A-Za-z0-9_-]{43,}') "$mode exposed a setup Token."
        if ($mode -eq 'no-docker') {
            Assert-Contract ($output -match 'Docker is unavailable') (
                'The Docker-unavailable failure was not observable.'
            )
        }
        $results += [ordered]@{ name = $mode; exitCode = $process.ExitCode }
    }

    $privateRoots = @(
        Get-ChildItem -LiteralPath $childTemp -Directory -Filter 'rc-bootstrap-installer.*' `
            -ErrorAction SilentlyContinue
    )
    Assert-Contract ($privateRoots.Count -eq 0) 'The installer left private Capsule files behind.'
    $diagnosticLogs = @(
        Get-ChildItem -LiteralPath $childTemp -File -Filter 'rc-docker-install-*.log' `
            -ErrorAction SilentlyContinue
    )
    foreach ($log in $diagnosticLogs) {
        $logText = Get-Content -LiteralPath $log.FullName -Raw -ErrorAction Stop
        Assert-Contract ($logText -notmatch 'rca_[A-Za-z0-9_-]{43,}') (
            'The installer diagnostic log exposed a setup Token.'
        )
        Remove-Item -LiteralPath $log.FullName -Force -ErrorAction Stop
    }
    Assert-Contract (
        @(Get-ChildItem -LiteralPath $childTemp -Force -ErrorAction Stop).Count -eq 0
    ) 'The installer left unexpected temporary artifacts behind.'

    [ordered]@{
        ok = $true
        osArchitecture = 'x64'
        processorArchitecture = $processorArchitecture
        processorCount = $processors.Count
        edition = $PSVersionTable.PSEdition
        version = $PSVersionTable.PSVersion.ToString()
        installerSha256 = $installerSha256
        acceptanceHarnessSha256 = $acceptanceHarnessSha256
        tokens = $tokens.Count
        acceptanceTokens = $acceptanceTokens.Count
        scenarios = $results
    } | ConvertTo-Json -Depth 5
} finally {
    if ($installerBytes) { [Array]::Clear($installerBytes, 0, $installerBytes.Length) }
    if ($acceptanceBytes) { [Array]::Clear($acceptanceBytes, 0, $acceptanceBytes.Length) }
    $installerText = $null
    $acceptanceText = $null
    $installerBase64 = $null
    $env:PATH = $savedPath
    $env:TEMP = $savedTemp
    $env:TMP = $savedTmp
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
