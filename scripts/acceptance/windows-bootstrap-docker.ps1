# Research-Claw 0.8.3 Bootstrap Capsule - Windows x64 Docker Desktop gate
#
# This is a destructive acceptance harness for an otherwise empty disposable
# Windows host/VM. It invokes the production installer in-process so an Auth
# Token is never placed in argv or an environment variable. It must be run once
# from Windows PowerShell 5.1 and once from PowerShell 7; each run gets its own
# evidence directory and secret bundle.
#
# The ACL-protected secret bundle has this exact shape (values omitted):
#   {"schemaVersion":1,"tokens":{"network":"...","unknown":"...",
#    "revoked":"...","badCapsule":"...","valid":"...","rotate":"...",
#    "healthFail":"..."},"modelKeys":{"badCapsule":"...","valid":"...",
#    "rotate":"...","healthFail":"..."}}
# The current user must own the file; inheritance must be disabled; only that
# user, SYSTEM, and Administrators may have allow ACEs. The non-secret manifest
# pins the installer, this helper, both registry/image digests, labels, fixture
# authority, and expected Profile revisions. Missing fault fixtures are a hard
# failure, never a skipped/pass result. T10 fixture model keys must use printable
# ASCII excluding quote/backslash so raw-volume occurrence counts are exact;
# this fixture constraint does not narrow the product's Capsule v1 key schema.
#
# Example invocations (the secret values remain inside SecretBundlePath):
#   powershell.exe -NoProfile -File .\windows-bootstrap-docker.ps1 `
#     -ManifestPath .\gate.json -SecretBundlePath .\gate.secrets.json `
#     -EvidenceDirectory .\evidence-ps51 -DisposableHostConfirmed
#   pwsh.exe -NoProfile -File .\windows-bootstrap-docker.ps1 `
#     -ManifestPath .\gate.json -SecretBundlePath .\gate.secrets.json `
#     -EvidenceDirectory .\evidence-ps7 -DisposableHostConfirmed

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$SecretBundlePath,
    [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
    [string]$InstallerPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'install-docker.ps1'),
    [switch]$DisposableHostConfirmed
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:Container = 'research-claw'
$script:RollbackContainer = 'research-claw-rollback'
$script:ProbeContainer = 'research-claw-t10-probe'
$script:VolumeNames = @('rc-config', 'rc-data', 'rc-workspace', 'rc-state')
$script:ExpectedVersion = '0.8.3'
$script:ExpectedRedeemEndpoint = 'https://wentor.ai/api/v1/rc/bootstrap/redeem'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false, $true)
$script:RunId = [guid]::NewGuid().ToString('N')
$script:StartedAt = [DateTimeOffset]::UtcNow
$script:SecretNeedles = @()
$script:ScenarioResults = New-Object System.Collections.ArrayList
$script:RuntimeScans = New-Object System.Collections.ArrayList
$script:CapsuleAttestations = New-Object System.Collections.ArrayList
$script:GateMutated = $false
$script:EvidenceCreated = $false
$script:Manifest = $null
$script:Secrets = $null
$script:InstallerResolved = $null
$script:AcceptanceHarnessResolved = $null
$script:InstallerScriptBlock = $null
$script:VolumeHelperResolved = $null
$script:VolumeHelperSourceResolved = $null
$script:VolumeHelperSnapshotRoot = $null
$script:VolumeHelperSnapshotBytes = $null
$script:ManifestInputSha256 = $null
$script:ManifestInputText = $null
$script:SecretBundleInputSha256 = $null
$script:InstallerSnapshotSha256 = $null
$script:InstallerSecretFlowContract = $null
$script:AcceptanceHarnessStartSha256 = $null
$script:VolumeHelperSourceSha256 = $null
$script:VolumeHelperSnapshotRemoved = $false
$script:InputSourcesStableAtEnd = $false
$script:ManifestResolved = $null
$script:SecretBundleResolved = $null
$script:EvidenceResolved = $null
$script:CandidateRef = $null
$script:HealthFailRef = $null
$script:CandidateDigestRef = $null
$script:HealthFailDigestRef = $null
$script:CandidateImageId = $null
$script:HealthFailImageId = $null
$script:CandidateCleanupImageId = $null
$script:HealthFailCleanupImageId = $null
$script:CandidateImageInspect = $null
$script:HealthFailImageInspect = $null
$script:DockerEvidence = $null
$script:WindowsPlatformEvidence = $null
$script:UserMarkerBaseline = $null
$script:ImageParityEvidence = $null
$script:OriginalMirror = $env:MIRROR
$script:OriginalProxy = [ordered]@{}
foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
        'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')) {
    $script:OriginalProxy[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
}
$script:OriginalDefaultProxy = [System.Net.WebRequest]::DefaultWebProxy
$script:TempBaseline = @()

function Fail-Gate([string]$Code) {
    throw (New-Object System.InvalidOperationException($Code))
}

function Get-FullPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.IndexOf([char]0) -ge 0) {
        Fail-Gate 'INVALID_PATH_ARGUMENT'
    }
    return [System.IO.Path]::GetFullPath($Value)
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$Code
    )
    if ($null -eq $Value) { Fail-Gate $Code }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    if ($actual.Count -ne $expected.Count) { Fail-Gate $Code }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if ($actual[$index] -cne $expected[$index]) { Fail-Gate $Code }
    }
}

function Read-StrictUtf8Snapshot {
    param([string]$Path, [int]$MaxBytes, [string]$Code)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
        $item.Length -le 0 -or $item.Length -gt $MaxBytes) {
        Fail-Gate $Code
    }
    $stream = $null
    $bytes = $null
    try {
        # FileShare.Read prevents a Windows path replacement or write while the
        # exact bytes used for hashing/parsing/compilation are captured.
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        if ($stream.Length -ne $item.Length -or $stream.Length -le 0 -or
            $stream.Length -gt $MaxBytes -or $stream.Length -gt [int]::MaxValue) {
            Fail-Gate $Code
        }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -le 0) { Fail-Gate $Code }
            $offset += $read
        }
        if ($stream.Position -ne $stream.Length) { Fail-Gate $Code }
        $text = $script:Utf8NoBom.GetString($bytes)
        if ($text.IndexOf([char]0) -ge 0) { Fail-Gate $Code }
        return [pscustomobject][ordered]@{
            bytes = $bytes
            text = $text
            sha256 = Get-BytesSha256 $bytes
        }
    } catch {
        Fail-Gate $Code
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Read-StrictUtf8JsonSnapshot {
    param([string]$Path, [int]$MaxBytes, [string]$Code)
    $snapshot = Read-StrictUtf8Snapshot $Path $MaxBytes $Code
    try {
        $value = ($snapshot.text | ConvertFrom-Json -ErrorAction Stop)
        return [pscustomobject][ordered]@{
            value = $value
            text = $snapshot.text
            sha256 = $snapshot.sha256
            bytes = $snapshot.bytes
        }
    } catch {
        Fail-Gate $Code
    }
}

function Get-BytesSha256([byte[]]$Bytes) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Get-StringSha256([string]$Value) {
    return Get-BytesSha256 $script:Utf8NoBom.GetBytes($Value)
}

function Get-FileSha256([string]$Path) {
    return Get-BytesSha256 ([System.IO.File]::ReadAllBytes($Path))
}

function Test-JsonIntegerOne($Value) {
    return $null -ne $Value -and
        @('Int32', 'Int64') -contains $Value.GetType().Name -and
        [int64]$Value -eq 1
}

function Test-JsonString($Value) {
    return $null -ne $Value -and $Value.GetType().Name -ceq 'String'
}

function Test-JsonBoolean($Value) {
    return $null -ne $Value -and $Value.GetType().Name -ceq 'Boolean'
}

function Assert-InstallerSecretFlowContract {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$InstallerSha256
    )
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $Source,
        [ref]$tokens,
        [ref]$errors
    )
    if ($errors.Count -ne 0 -or $null -eq $ast.ParamBlock -or
        $ast.ParamBlock.Parameters.Count -ne 1 -or
        $ast.ParamBlock.Parameters[0].Name.VariablePath.UserPath -cne 'AuthToken') {
        Fail-Gate 'INSTALLER_SECRET_FLOW_CONTRACT_FAILED'
    }
    $references = @($ast.FindAll({
                param($node)
                return $node -is [System.Management.Automation.Language.VariableExpressionAst] -and
                    $node.VariablePath.UserPath -ceq 'AuthToken'
            }, $true) | Sort-Object { $_.Extent.StartOffset })
    $expectedTypes = @(
        'ParameterAst',
        'InvokeMemberExpressionAst',
        'BinaryExpressionAst',
        'ExpandableStringExpressionAst'
    )
    $expectedContexts = @(
        '[string]$AuthToken',
        '[string]::IsNullOrWhiteSpace($AuthToken)',
        '$AuthToken -notmatch ''^rca_[A-Za-z0-9_-]{43,}$''',
        '"Bearer $AuthToken"'
    )
    if ($references.Count -ne $expectedContexts.Count) {
        Fail-Gate 'INSTALLER_SECRET_FLOW_CONTRACT_FAILED'
    }
    for ($index = 0; $index -lt $expectedContexts.Count; $index++) {
        if ($references[$index].Parent.GetType().Name -cne $expectedTypes[$index] -or
            $references[$index].Parent.Extent.Text.Trim() -cne $expectedContexts[$index]) {
            Fail-Gate 'INSTALLER_SECRET_FLOW_CONTRACT_FAILED'
        }
    }
    $headerInvocation = $references[3].Parent.Parent
    if ($headerInvocation.GetType().Name -cne 'InvokeMemberExpressionAst' -or
        $headerInvocation.Extent.Text.Trim() -cne
            '$request.Headers.TryAddWithoutValidation(''Authorization'', "Bearer $AuthToken")') {
        Fail-Gate 'INSTALLER_SECRET_FLOW_CONTRACT_FAILED'
    }
    if ($Source.IndexOf('modelApiKey', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Fail-Gate 'INSTALLER_SECRET_FLOW_CONTRACT_FAILED'
    }
    $capsuleReferences = @($ast.FindAll({
                param($node)
                return $node -is [System.Management.Automation.Language.VariableExpressionAst] -and
                    $node.VariablePath.UserPath -ceq 'script:RcProfileCapsule'
            }, $true) | Sort-Object { $_.Extent.StartOffset })
    $expectedCapsuleTypes = @(
        'AssignmentStatementAst',
        'AssignmentStatementAst',
        'AssignmentStatementAst',
        'InvokeMemberExpressionAst',
        'CommandAst'
    )
    $expectedCapsuleContexts = @(
        '$script:RcProfileCapsule = $null',
        '$script:RcProfileCapsule = $null',
        '$script:RcProfileCapsule = Join-Path $root ''capsule.json''',
        '[System.IO.File]::WriteAllBytes($script:RcProfileCapsule, $bytes)',
        'Invoke-RcBootstrapDockerCli -Command ''stage'' -InputPath $script:RcProfileCapsule'
    )
    if ($capsuleReferences.Count -ne $expectedCapsuleContexts.Count) {
        Fail-Gate 'INSTALLER_SECRET_FLOW_CONTRACT_FAILED'
    }
    for ($index = 0; $index -lt $expectedCapsuleContexts.Count; $index++) {
        if ($capsuleReferences[$index].Parent.GetType().Name -cne
                $expectedCapsuleTypes[$index] -or
            $capsuleReferences[$index].Parent.Extent.Text.Trim() -cne
                $expectedCapsuleContexts[$index]) {
            Fail-Gate 'INSTALLER_SECRET_FLOW_CONTRACT_FAILED'
        }
    }
    $clearCommands = @($ast.FindAll({
                param($node)
                return $node -is [System.Management.Automation.Language.CommandAst] -and
                    $node.GetCommandName() -ceq 'Set-Variable' -and
                    $node.Extent.Text.Trim() -ceq
                        'Set-Variable -Name AuthToken -Scope 1 -Value $null'
            }, $true))
    $bindingRemovalInvocations = @($ast.FindAll({
                param($node)
                return $node -is
                    [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
                    $node.Extent.Text.Trim() -ceq
                        '$parentBoundParameters.Remove(''AuthToken'')'
            }, $true))
    $redirectedDockerCommands = @($ast.FindAll({
                param($node)
                return $node -is [System.Management.Automation.Language.CommandAst] -and
                    $node.GetCommandName() -ceq 'Start-Process' -and
                    $node.Extent.Text.Contains('-RedirectStandardInput')
            }, $true))
    if ($clearCommands.Count -ne 2 -or $bindingRemovalInvocations.Count -ne 2 -or
        $redirectedDockerCommands.Count -ne 1 -or
        -not $redirectedDockerCommands[0].Extent.Text.Contains("-FilePath 'docker'") -or
        -not $redirectedDockerCommands[0].Extent.Text.Contains(
            '-RedirectStandardInput $InputPath'
        )) {
        Fail-Gate 'INSTALLER_SECRET_FLOW_CONTRACT_FAILED'
    }
    $projection = [ordered]@{
        schemaVersion = 1
        installerSha256 = $InstallerSha256
        topLevelParameter = 'AuthToken'
        authTokenReferenceCount = $references.Count
        authTokenReferenceContexts = $expectedTypes
        authTokenClearCount = 2
        boundParameterRemovalCount = 2
        modelApiKeySourceReferences = 0
        capsulePathReferenceCount = $capsuleReferences.Count
        capsulePathReferenceContexts = $expectedCapsuleTypes
        capsuleTransport = 'private-file-to-helper-stdin'
    }
    return [pscustomobject][ordered]@{
        passed = $true
        proofMethod = 'powershell-ast-exact-snapshot-plus-runtime-posthoc'
        projectionSha256 = Get-StringSha256 (
            $projection | ConvertTo-Json -Compress -Depth 5
        )
        projection = $projection
    }
}

function Test-SecretStringEqual {
    param(
        [AllowNull()][object]$ActualModelKey,
        [AllowNull()][object]$ExpectedModelKey
    )
    if (-not (Test-JsonString $ActualModelKey) -or
        -not (Test-JsonString $ExpectedModelKey)) {
        return $false
    }
    $actualBytes = $null
    $expectedBytes = $null
    try {
        $actualBytes = $script:Utf8NoBom.GetBytes([string]$ActualModelKey)
        $expectedBytes = $script:Utf8NoBom.GetBytes([string]$ExpectedModelKey)
        $difference = $actualBytes.Length -bxor $expectedBytes.Length
        $limit = [Math]::Max($actualBytes.Length, $expectedBytes.Length)
        for ($index = 0; $index -lt $limit; $index++) {
            $actual = if ($index -lt $actualBytes.Length) { $actualBytes[$index] } else { 0 }
            $expected = if ($index -lt $expectedBytes.Length) { $expectedBytes[$index] } else { 0 }
            $difference = $difference -bor ($actual -bxor $expected)
        }
        return $difference -eq 0
    } finally {
        if ($actualBytes) { [Array]::Clear($actualBytes, 0, $actualBytes.Length) }
        if ($expectedBytes) { [Array]::Clear($expectedBytes, 0, $expectedBytes.Length) }
    }
}

function Assert-SecretBundleAcl([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Fail-Gate 'SECRET_BUNDLE_NOT_REGULAR'
    }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = $identity.User.Value
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -cne $currentSid -or -not $acl.AreAccessRulesProtected) {
        Fail-Gate 'SECRET_BUNDLE_ACL_NOT_PRIVATE'
    }
    $allowed = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
    $currentUserCanRead = $false
    foreach ($rule in $acl.GetAccessRules($true, $true,
            [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.IsInherited) { Fail-Gate 'SECRET_BUNDLE_ACL_NOT_PRIVATE' }
        $sid = $rule.IdentityReference.Value
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
            if ($allowed -notcontains $sid) { Fail-Gate 'SECRET_BUNDLE_ACL_NOT_PRIVATE' }
            if ($sid -ceq $currentSid -and
                (($rule.FileSystemRights -band
                    [System.Security.AccessControl.FileSystemRights]::ReadData) -ne 0)) {
                $currentUserCanRead = $true
            }
        }
    }
    if (-not $currentUserCanRead) { Fail-Gate 'SECRET_BUNDLE_ACL_NOT_PRIVATE' }
}

function New-PrivateEvidenceDirectory([string]$Path) {
    if (Test-Path -LiteralPath $Path) { Fail-Gate 'EVIDENCE_DIRECTORY_ALREADY_EXISTS' }
    $parent = Split-Path -Parent $Path
    $parentItem = Get-Item -LiteralPath $parent -Force -ErrorAction Stop
    if (-not $parentItem.PSIsContainer -or
        (($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Fail-Gate 'INVALID_EVIDENCE_PARENT'
    }
    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity.User)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity.User,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $security
    $script:EvidenceCreated = $true
}

function New-VolumeHelperSnapshot {
    if ($null -eq $script:VolumeHelperSnapshotBytes -or
        $script:VolumeHelperSnapshotBytes.Length -le 0) {
        Fail-Gate 'EVIDENCE_HELPER_SNAPSHOT_MISSING'
    }
    $root = Join-Path $script:EvidenceResolved ('.gate-inputs-' + $script:RunId)
    if (Test-Path -LiteralPath $root) { Fail-Gate 'EVIDENCE_HELPER_SNAPSHOT_EXISTS' }
    [System.IO.Directory]::CreateDirectory($root) | Out-Null
    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer -or
        (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Fail-Gate 'EVIDENCE_HELPER_SNAPSHOT_UNSAFE'
    }
    $target = Join-Path $root 'windows-volume-evidence.cjs'
    $script:VolumeHelperSnapshotRoot = $root
    $script:VolumeHelperResolved = $target
    try {
        $stream = $null
        try {
            $stream = [System.IO.File]::Open(
                $target,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            $stream.Write(
                $script:VolumeHelperSnapshotBytes,
                0,
                $script:VolumeHelperSnapshotBytes.Length
            )
            $stream.Flush($true)
        } finally {
            if ($stream) { $stream.Dispose() }
        }
        $snapshot = Read-StrictUtf8Snapshot $target 1048576 `
            'EVIDENCE_HELPER_SNAPSHOT_UNSAFE'
        try {
            if ([string]$snapshot.sha256 -cne $script:VolumeHelperSourceSha256 -or
                $snapshot.bytes.Length -ne $script:VolumeHelperSnapshotBytes.Length) {
                Fail-Gate 'EVIDENCE_HELPER_SNAPSHOT_MISMATCH'
            }
        } finally {
            if ($snapshot.bytes) {
                [Array]::Clear($snapshot.bytes, 0, $snapshot.bytes.Length)
            }
            $snapshot.text = $null
            [Array]::Clear(
                $script:VolumeHelperSnapshotBytes,
                0,
                $script:VolumeHelperSnapshotBytes.Length
            )
            $script:VolumeHelperSnapshotBytes = $null
        }
    } catch {
        try {
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Force -ErrorAction Stop
            }
            if (Test-Path -LiteralPath $root) {
                Remove-Item -LiteralPath $root -Force -ErrorAction Stop
            }
        } catch {}
        $script:VolumeHelperSnapshotRoot = $null
        $script:VolumeHelperResolved = $null
        throw
    }
}

function Remove-VolumeHelperSnapshot {
    if ([string]::IsNullOrEmpty($script:VolumeHelperSnapshotRoot)) { return }
    $root = Get-FullPath $script:VolumeHelperSnapshotRoot
    $target = Get-FullPath $script:VolumeHelperResolved
    if ((Split-Path -Parent $root) -cne $script:EvidenceResolved -or
        (Split-Path -Parent $target) -cne $root -or
        (Split-Path -Leaf $target) -cne 'windows-volume-evidence.cjs') {
        Fail-Gate 'EVIDENCE_HELPER_SNAPSHOT_CLEANUP_UNSAFE'
    }
    $snapshot = Read-StrictUtf8Snapshot $target 1048576 `
        'EVIDENCE_HELPER_SNAPSHOT_CLEANUP_UNSAFE'
    try {
        if ([string]$snapshot.sha256 -cne $script:VolumeHelperSourceSha256) {
            Fail-Gate 'EVIDENCE_HELPER_SNAPSHOT_CHANGED'
        }
    } finally {
        if ($snapshot.bytes) { [Array]::Clear($snapshot.bytes, 0, $snapshot.bytes.Length) }
        $snapshot.text = $null
    }
    Remove-Item -LiteralPath $target -Force -ErrorAction Stop
    Remove-Item -LiteralPath $root -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $root) { Fail-Gate 'EVIDENCE_HELPER_SNAPSHOT_CLEANUP_FAILED' }
    $script:VolumeHelperSnapshotRoot = $null
    $script:VolumeHelperResolved = $null
    $script:VolumeHelperSnapshotRemoved = $true
}

function Assert-InputSourcesStable {
    $inputs = @(
        [pscustomobject]@{
            path = $script:AcceptanceHarnessResolved
            sha256 = $script:AcceptanceHarnessStartSha256
            code = 'ACCEPTANCE_HARNESS_CHANGED_DURING_GATE'
            maxBytes = 1048576
        },
        [pscustomobject]@{
            path = $script:InstallerResolved
            sha256 = $script:InstallerSnapshotSha256
            code = 'INSTALLER_CHANGED_DURING_GATE'
            maxBytes = 1048576
        },
        [pscustomobject]@{
            path = $script:VolumeHelperSourceResolved
            sha256 = $script:VolumeHelperSourceSha256
            code = 'EVIDENCE_HELPER_CHANGED_DURING_GATE'
            maxBytes = 1048576
        },
        [pscustomobject]@{
            path = $script:ManifestResolved
            sha256 = $script:ManifestInputSha256
            code = 'MANIFEST_CHANGED_DURING_GATE'
            maxBytes = 262144
        },
        [pscustomobject]@{
            path = $script:SecretBundleResolved
            sha256 = $script:SecretBundleInputSha256
            code = 'SECRET_BUNDLE_CHANGED_DURING_GATE'
            maxBytes = 262144
        }
    )
    foreach ($input in $inputs) {
        $snapshot = Read-StrictUtf8Snapshot $input.path ([int]$input.maxBytes) $input.code
        try {
            if ([string]$snapshot.sha256 -cne [string]$input.sha256) {
                Fail-Gate $input.code
            }
        } finally {
            if ($snapshot.bytes) { [Array]::Clear($snapshot.bytes, 0, $snapshot.bytes.Length) }
            $snapshot.text = $null
        }
    }
    $script:InputSourcesStableAtEnd = $true
}

function Invoke-Docker {
    param([string[]]$Arguments, [switch]$AllowFailure, [switch]$SkipSecretScan)
    # Windows PowerShell 5.1 turns native stderr into terminating errors when
    # the caller uses ErrorActionPreference=Stop. Isolate every Docker call so
    # expected probe misses keep their real process exit code.
    $native = & {
        $ErrorActionPreference = 'Continue'
        $nativeLines = @(& docker @Arguments 2>&1 | ForEach-Object { [string]$_ })
        [pscustomobject]@{ lines = $nativeLines; exitCode = $LASTEXITCODE }
    }
    $lines = @($native.lines)
    $exitCode = [int]$native.exitCode
    $text = $lines -join "`n"
    if (-not $SkipSecretScan -and $script:SecretNeedles.Count -gt 0) {
        Assert-NoSecretText $text 'DOCKER_OUTPUT_SECRET_LEAK'
    }
    if (-not $AllowFailure -and $exitCode -ne 0) { Fail-Gate 'DOCKER_COMMAND_FAILED' }
    return [pscustomobject][ordered]@{
        exitCode = $exitCode
        text = $text
        sha256 = Get-StringSha256 $text
    }
}

function Assert-NoSecretText([string]$Text, [string]$Code) {
    if (Test-TextContainsSecret $Text) { Fail-Gate $Code }
}

function Test-TextContainsSecret([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return $false }
    foreach ($needle in $script:SecretNeedles) {
        if ($Text.Contains([string]$needle)) { return $true }
    }
    return $Text -match 'rca_[A-Za-z0-9_-]{43,}'
}

function Test-BytesContainSecret([byte[]]$Bytes) {
    foreach ($encoding in @(
            [System.Text.Encoding]::UTF8,
            [System.Text.Encoding]::Unicode,
            [System.Text.Encoding]::BigEndianUnicode,
            [System.Text.Encoding]::Default)) {
        if (Test-TextContainsSecret $encoding.GetString($Bytes)) { return $true }
    }
    return $false
}

function Assert-Repository([string]$Value) {
    if ($Value -cne $Value.ToLowerInvariant() -or
        $Value -notmatch '^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$' -or
        $Value.Contains('@')) {
        Fail-Gate 'INVALID_IMAGE_REPOSITORY'
    }
}

function Assert-ImageManifest($Image, [bool]$HealthFail) {
    $imageProperties = if ($HealthFail) {
        @('repository', 'tag', 'registryDigest', 'labels',
            'failureEntrypoint', 'failureEntrypointSha256')
    } else {
        @('repository', 'tag', 'registryDigest', 'labels', 'criticalRuntimeSha256')
    }
    Assert-ExactProperties $Image $imageProperties 'INVALID_IMAGE_MANIFEST'
    if (-not (Test-JsonString $Image.repository) -or
        -not (Test-JsonString $Image.tag) -or
        -not (Test-JsonString $Image.registryDigest)) {
        Fail-Gate 'INVALID_IMAGE_MANIFEST'
    }
    Assert-Repository ([string]$Image.repository)
    if ([string]$Image.tag -cne 'latest' -or
        [string]$Image.registryDigest -notmatch '^sha256:[0-9a-f]{64}$') {
        Fail-Gate 'INVALID_IMAGE_MANIFEST'
    }
    $labelNames = if ($HealthFail) {
        @('org.opencontainers.image.version', 'org.opencontainers.image.revision',
            'ai.wentor.acceptance.failure-mode')
    } else {
        @('org.opencontainers.image.version', 'org.opencontainers.image.revision')
    }
    Assert-ExactProperties $Image.labels $labelNames 'INVALID_IMAGE_LABEL_MANIFEST'
    foreach ($labelName in $labelNames) {
        if (-not (Test-JsonString $Image.labels.$labelName)) {
            Fail-Gate 'INVALID_IMAGE_LABEL_MANIFEST'
        }
    }
    if ([string]$Image.labels.'org.opencontainers.image.version' -cne $script:ExpectedVersion -or
        [string]$Image.labels.'org.opencontainers.image.revision' -notmatch '^[0-9a-f]{40}$') {
        Fail-Gate 'INVALID_IMAGE_LABEL_MANIFEST'
    }
    if ($HealthFail -and
        [string]$Image.labels.'ai.wentor.acceptance.failure-mode' -cne 'health-fail') {
        Fail-Gate 'INVALID_IMAGE_LABEL_MANIFEST'
    }
    if (-not $HealthFail -and (
        -not (Test-JsonString $Image.criticalRuntimeSha256) -or
        [string]$Image.criticalRuntimeSha256 -notmatch '^[0-9a-f]{64}$')) {
        Fail-Gate 'INVALID_CRITICAL_RUNTIME_MANIFEST'
    }
    if ($HealthFail -and (
        -not (Test-JsonString $Image.failureEntrypoint) -or
        -not (Test-JsonString $Image.failureEntrypointSha256) -or
        [string]$Image.failureEntrypoint -notmatch '^/[A-Za-z0-9._/-]+$' -or
        [string]$Image.failureEntrypoint -ceq '/entrypoint.sh' -or
        [string]$Image.failureEntrypointSha256 -notmatch '^[0-9a-f]{64}$')) {
        Fail-Gate 'INVALID_HEALTH_FAIL_ENTRYPOINT_MANIFEST'
    }
}

function Assert-ProfileManifest($Profile) {
    Assert-ExactProperties $Profile @('id', 'revision', 'digest') 'INVALID_PROFILE_EXPECTATION'
    if (-not (Test-JsonString $Profile.id) -or
        -not (Test-JsonString $Profile.digest) -or
        $null -eq $Profile.revision -or
        [string]$Profile.id -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or
        @('Int32', 'Int64') -notcontains $Profile.revision.GetType().Name -or
        [int64]$Profile.revision -lt 1 -or [int64]$Profile.revision -gt [int]::MaxValue -or
        [string]$Profile.digest -notmatch '^[0-9a-f]{64}$') {
        Fail-Gate 'INVALID_PROFILE_EXPECTATION'
    }
}

function Read-AndValidateInputs {
    $script:ManifestResolved = Get-FullPath $ManifestPath
    $script:SecretBundleResolved = Get-FullPath $SecretBundlePath
    $script:InstallerResolved = Get-FullPath $InstallerPath
    $script:AcceptanceHarnessResolved = Get-FullPath $PSCommandPath
    $script:EvidenceResolved = Get-FullPath $EvidenceDirectory
    if ($script:ManifestResolved -ceq $script:SecretBundleResolved -or
        $script:EvidenceResolved -ceq $script:ManifestResolved -or
        $script:EvidenceResolved -ceq $script:SecretBundleResolved) {
        Fail-Gate 'INPUT_PATH_ALIAS'
    }
    Assert-SecretBundleAcl $script:SecretBundleResolved
    $manifestSnapshot = Read-StrictUtf8JsonSnapshot $script:ManifestResolved 262144 `
        'INVALID_MANIFEST_JSON'
    $script:Manifest = $manifestSnapshot.value
    $script:ManifestInputSha256 = [string]$manifestSnapshot.sha256
    $script:ManifestInputText = [string]$manifestSnapshot.text
    if ($manifestSnapshot.bytes) {
        [Array]::Clear($manifestSnapshot.bytes, 0, $manifestSnapshot.bytes.Length)
    }
    Assert-ExactProperties $script:Manifest @(
        'schemaVersion', 'gateId', 'redeemEndpoint', 'fixtureAuthority',
        'acceptanceHarness', 'installer', 'evidenceHelper', 'images',
        'expectedProfiles', 'expectedFailures'
    ) 'INVALID_MANIFEST'
    if (-not (Test-JsonIntegerOne $script:Manifest.schemaVersion) -or
        -not (Test-JsonString $script:Manifest.gateId) -or
        -not (Test-JsonString $script:Manifest.redeemEndpoint) -or
        [string]$script:Manifest.gateId -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or
        [string]$script:Manifest.redeemEndpoint -cne $script:ExpectedRedeemEndpoint) {
        Fail-Gate 'INVALID_MANIFEST'
    }
    Assert-ExactProperties $script:Manifest.fixtureAuthority @(
        'id', 'expiresAtUtc', 'notForProduction', 'cases'
    ) 'INVALID_FIXTURE_AUTHORITY'
    Assert-ExactProperties $script:Manifest.fixtureAuthority.cases @(
        'network', 'unknown', 'revoked', 'badCapsule', 'valid', 'rotate', 'healthFail'
    ) 'INVALID_FIXTURE_AUTHORITY'
    if (-not (Test-JsonString $script:Manifest.fixtureAuthority.id) -or
        -not (Test-JsonString $script:Manifest.fixtureAuthority.expiresAtUtc) -or
        -not (Test-JsonBoolean $script:Manifest.fixtureAuthority.notForProduction) -or
        [string]$script:Manifest.fixtureAuthority.id -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or
        $script:Manifest.fixtureAuthority.notForProduction -ne $true) {
        Fail-Gate 'INVALID_FIXTURE_AUTHORITY'
    }
    foreach ($caseName in @('network', 'unknown', 'revoked', 'badCapsule', 'valid', 'rotate', 'healthFail')) {
        if (-not (Test-JsonBoolean $script:Manifest.fixtureAuthority.cases.$caseName) -or
            $script:Manifest.fixtureAuthority.cases.$caseName -ne $true) {
            Fail-Gate 'MISSING_STAGING_FAULT_FIXTURE'
        }
    }
    try {
        $expires = [DateTimeOffset]::Parse(
            [string]$script:Manifest.fixtureAuthority.expiresAtUtc,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal
        )
    } catch {
        Fail-Gate 'INVALID_FIXTURE_AUTHORITY'
    }
    if ($expires -le [DateTimeOffset]::UtcNow) { Fail-Gate 'STAGING_FAULT_FIXTURES_EXPIRED' }

    Assert-ExactProperties $script:Manifest.acceptanceHarness @('sha256') `
        'INVALID_ACCEPTANCE_HARNESS_MANIFEST'
    $harnessSnapshot = Read-StrictUtf8Snapshot $script:AcceptanceHarnessResolved 1048576 `
        'ACCEPTANCE_HARNESS_SHA256_MISMATCH'
    $script:AcceptanceHarnessStartSha256 = [string]$harnessSnapshot.sha256
    if (-not (Test-JsonString $script:Manifest.acceptanceHarness.sha256) -or
        [string]$script:Manifest.acceptanceHarness.sha256 -notmatch '^[0-9a-f]{64}$' -or
        $script:AcceptanceHarnessStartSha256 -cne
            [string]$script:Manifest.acceptanceHarness.sha256) {
        Fail-Gate 'ACCEPTANCE_HARNESS_SHA256_MISMATCH'
    }
    [Array]::Clear($harnessSnapshot.bytes, 0, $harnessSnapshot.bytes.Length)
    $harnessSnapshot.text = $null

    Assert-ExactProperties $script:Manifest.installer @('sha256') 'INVALID_INSTALLER_MANIFEST'
    if (-not (Test-JsonString $script:Manifest.installer.sha256) -or
        [string]$script:Manifest.installer.sha256 -notmatch '^[0-9a-f]{64}$') {
        Fail-Gate 'INVALID_INSTALLER_MANIFEST'
    }
    $installerSnapshot = Read-StrictUtf8Snapshot $script:InstallerResolved 1048576 `
        'INSTALLER_SHA256_MISMATCH'
    $script:InstallerSnapshotSha256 = [string]$installerSnapshot.sha256
    if ($script:InstallerSnapshotSha256 -cne [string]$script:Manifest.installer.sha256) {
        Fail-Gate 'INSTALLER_SHA256_MISMATCH'
    }
    try {
        $script:InstallerSecretFlowContract = Assert-InstallerSecretFlowContract `
            $installerSnapshot.text $script:InstallerSnapshotSha256
        # Compile exactly the SHA-pinned UTF-8 bytes into the same dynamic
        # scriptblock shape as: [scriptblock]::Create((irm <public URL>)).
        $script:InstallerScriptBlock = [scriptblock]::Create($installerSnapshot.text)
    } catch {
        Fail-Gate 'INVALID_INSTALLER_SOURCE'
    } finally {
        if ($installerSnapshot.bytes) {
            [Array]::Clear($installerSnapshot.bytes, 0, $installerSnapshot.bytes.Length)
        }
        $installerSnapshot.text = $null
    }
    $script:VolumeHelperSourceResolved = Get-FullPath (
        Join-Path $PSScriptRoot 'windows-volume-evidence.cjs'
    )
    Assert-ExactProperties $script:Manifest.evidenceHelper @('sha256') `
        'INVALID_EVIDENCE_HELPER_MANIFEST'
    $helperSnapshot = Read-StrictUtf8Snapshot $script:VolumeHelperSourceResolved 1048576 `
        'EVIDENCE_HELPER_SHA256_MISMATCH'
    $script:VolumeHelperSourceSha256 = [string]$helperSnapshot.sha256
    if (-not (Test-JsonString $script:Manifest.evidenceHelper.sha256) -or
        [string]$script:Manifest.evidenceHelper.sha256 -notmatch '^[0-9a-f]{64}$' -or
        $script:VolumeHelperSourceSha256 -cne
            [string]$script:Manifest.evidenceHelper.sha256) {
        Fail-Gate 'EVIDENCE_HELPER_SHA256_MISMATCH'
    }
    $script:VolumeHelperSnapshotBytes = $helperSnapshot.bytes
    $helperSnapshot.text = $null

    Assert-ExactProperties $script:Manifest.images @('candidate', 'healthFail') 'INVALID_IMAGE_MANIFEST'
    Assert-ImageManifest $script:Manifest.images.candidate $false
    Assert-ImageManifest $script:Manifest.images.healthFail $true
    $script:CandidateRef = '{0}:{1}' -f $script:Manifest.images.candidate.repository,
        $script:Manifest.images.candidate.tag
    $script:HealthFailRef = '{0}:{1}' -f $script:Manifest.images.healthFail.repository,
        $script:Manifest.images.healthFail.tag
    $script:CandidateDigestRef = '{0}@{1}' -f $script:Manifest.images.candidate.repository,
        $script:Manifest.images.candidate.registryDigest
    $script:HealthFailDigestRef = '{0}@{1}' -f $script:Manifest.images.healthFail.repository,
        $script:Manifest.images.healthFail.registryDigest
    if ($script:CandidateRef -ceq $script:HealthFailRef -or
        [string]$script:Manifest.images.candidate.registryDigest -ceq
            [string]$script:Manifest.images.healthFail.registryDigest) {
        Fail-Gate 'HEALTH_FAIL_IMAGE_MUST_BE_DISTINCT'
    }

    Assert-ExactProperties $script:Manifest.expectedProfiles @(
        'valid', 'rotate', 'healthFail'
    ) 'INVALID_PROFILE_EXPECTATIONS'
    Assert-ProfileManifest $script:Manifest.expectedProfiles.valid
    Assert-ProfileManifest $script:Manifest.expectedProfiles.rotate
    Assert-ProfileManifest $script:Manifest.expectedProfiles.healthFail
    $profileDigests = @(
        [string]$script:Manifest.expectedProfiles.valid.digest,
        [string]$script:Manifest.expectedProfiles.rotate.digest,
        [string]$script:Manifest.expectedProfiles.healthFail.digest
    )
    if ([string]$script:Manifest.expectedProfiles.valid.id -cne
            [string]$script:Manifest.expectedProfiles.rotate.id -or
        [string]$script:Manifest.expectedProfiles.valid.id -cne
            [string]$script:Manifest.expectedProfiles.healthFail.id -or
        [int]$script:Manifest.expectedProfiles.valid.revision -ge
            [int]$script:Manifest.expectedProfiles.rotate.revision -or
        [int]$script:Manifest.expectedProfiles.rotate.revision -ge
            [int]$script:Manifest.expectedProfiles.healthFail.revision -or
        @($profileDigests | Select-Object -Unique).Count -ne 3) {
        Fail-Gate 'PROFILE_ROTATION_EXPECTATIONS_INVALID'
    }

    Assert-ExactProperties $script:Manifest.expectedFailures @('badCapsule') `
        'INVALID_FAILURE_EXPECTATIONS'
    Assert-ExactProperties $script:Manifest.expectedFailures.badCapsule @('capsuleDigest') `
        'INVALID_FAILURE_EXPECTATIONS'
    if (-not (Test-JsonString $script:Manifest.expectedFailures.badCapsule.capsuleDigest) -or
        [string]$script:Manifest.expectedFailures.badCapsule.capsuleDigest -notmatch
            '^[0-9a-f]{64}$') {
        Fail-Gate 'INVALID_FAILURE_EXPECTATIONS'
    }

    $secretSnapshot = Read-StrictUtf8JsonSnapshot $script:SecretBundleResolved 262144 `
        'INVALID_SECRET_BUNDLE_JSON'
    $script:Secrets = $secretSnapshot.value
    $script:SecretBundleInputSha256 = [string]$secretSnapshot.sha256
    if ($secretSnapshot.bytes) {
        [Array]::Clear($secretSnapshot.bytes, 0, $secretSnapshot.bytes.Length)
    }
    $secretSnapshot.text = $null
    Assert-ExactProperties $script:Secrets @('schemaVersion', 'tokens', 'modelKeys') 'INVALID_SECRET_BUNDLE'
    Assert-ExactProperties $script:Secrets.tokens @(
        'network', 'unknown', 'revoked', 'badCapsule', 'valid', 'rotate', 'healthFail'
    ) 'INVALID_SECRET_BUNDLE'
    Assert-ExactProperties $script:Secrets.modelKeys @(
        'badCapsule', 'valid', 'rotate', 'healthFail'
    ) 'INVALID_SECRET_BUNDLE'
    if (-not (Test-JsonIntegerOne $script:Secrets.schemaVersion)) {
        Fail-Gate 'INVALID_SECRET_BUNDLE'
    }
    $tokens = @()
    foreach ($name in @('network', 'unknown', 'revoked', 'badCapsule', 'valid', 'rotate', 'healthFail')) {
        $tokenValue = $script:Secrets.tokens.$name
        if (-not (Test-JsonString $tokenValue)) { Fail-Gate 'INVALID_SECRET_TOKEN' }
        $token = [string]$tokenValue
        if ($token -notmatch '^rca_[A-Za-z0-9_-]{43,}$') { Fail-Gate 'INVALID_SECRET_TOKEN' }
        $tokens += $token
    }
    if (@($tokens | Select-Object -Unique).Count -ne $tokens.Count) {
        Fail-Gate 'SECRET_TOKENS_MUST_BE_DISTINCT'
    }
    $keys = @()
    $wireWhitespaceAtEdge = '^(?:[\u0009-\u000D\u001C-\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF])|(?:[\u0009-\u000D\u001C-\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF])$'
    foreach ($name in @('badCapsule', 'valid', 'rotate', 'healthFail')) {
        $keyValue = $script:Secrets.modelKeys.$name
        if ($null -eq $keyValue -or $keyValue.GetType().Name -cne 'String') {
            Fail-Gate 'INVALID_MODEL_KEY_NEEDLE'
        }
        $key = [string]$keyValue
        try { $keyBytes = $script:Utf8NoBom.GetByteCount($key) } catch {
            Fail-Gate 'INVALID_MODEL_KEY_NEEDLE'
        }
        # T10 fixtures intentionally use JSON-unescaped printable ASCII so an
        # exact raw-byte occurrence scan can prove the sole durable copy. This
        # is a gate-fixture constraint, not a narrowing of Capsule v1 schema.
        if ($keyBytes -lt 16 -or $keyBytes -gt 16384 -or
            $key -match $wireWhitespaceAtEdge -or
            $key -notmatch '^[\x21\x23-\x5B\x5D-\x7E]+$') {
            Fail-Gate 'INVALID_MODEL_KEY_NEEDLE'
        }
        $keys += $key
    }
    if (@($keys | Select-Object -Unique).Count -ne $keys.Count) {
        Fail-Gate 'MODEL_KEYS_MUST_BE_DISTINCT'
    }
    if (@(@($tokens + $keys) | Select-Object -Unique).Count -ne 11) {
        Fail-Gate 'SECRET_NEEDLES_MUST_BE_DISTINCT'
    }
    $script:SecretNeedles = @($tokens + $keys)
    Assert-NoSecretText $script:ManifestInputText 'MANIFEST_CONTAINS_SECRET'
}

function Assert-HostAndDockerPreflight {
    if (-not $DisposableHostConfirmed) { Fail-Gate 'DISPOSABLE_HOST_CONFIRMATION_REQUIRED' }
    if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or
        -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -cne 'AMD64') {
        Fail-Gate 'WINDOWS_X64_REQUIRED'
    }
    $operatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $processors = @(Get-CimInstance Win32_Processor -ErrorAction Stop)
    if ($processors.Count -lt 1 -or
        @($processors | Where-Object {
                [int]$_.Architecture -ne 9 -or [int]$_.AddressWidth -ne 64 -or
                [int]$_.DataWidth -ne 64
            }).Count -ne 0) {
        Fail-Gate 'NATIVE_WINDOWS_X64_REQUIRED'
    }
    $script:WindowsPlatformEvidence = [ordered]@{
        processArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
        osArchitecture = [string]$operatingSystem.OSArchitecture
        processorArchitectures = @($processors | ForEach-Object { [int]$_.Architecture })
        processorAddressWidths = @($processors | ForEach-Object { [int]$_.AddressWidth })
        processorDataWidths = @($processors | ForEach-Object { [int]$_.DataWidth })
    }
    $major = $PSVersionTable.PSVersion.Major
    if (($major -eq 5 -and $PSVersionTable.PSVersion.Minor -ne 1) -or
        ($major -ne 5 -and $major -ne 7)) {
        Fail-Gate 'POWERSHELL_5_1_OR_7_REQUIRED'
    }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Fail-Gate 'ADMINISTRATOR_REQUIRED'
    }
    if (-not (Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)) {
        Fail-Gate 'DOCKER_CLI_REQUIRED'
    }
    foreach ($entry in Get-ChildItem Env:) {
        if (Test-TextContainsSecret ([string]$entry.Value)) {
            Fail-Gate 'SECRET_PRESENT_IN_PROCESS_ENVIRONMENT'
        }
    }

    $infoResult = Invoke-Docker @('info', '--format', '{{json .}}')
    try { $info = ($infoResult.text | ConvertFrom-Json -ErrorAction Stop) } catch {
        Fail-Gate 'INVALID_DOCKER_INFO'
    }
    if ([string]$info.OSType -cne 'linux' -or
        @('x86_64', 'amd64') -notcontains [string]$info.Architecture -or
        [string]$info.OperatingSystem -notmatch 'Docker Desktop') {
        Fail-Gate 'DOCKER_DESKTOP_LINUX_AMD64_REQUIRED'
    }
    $versionResult = Invoke-Docker @('version', '--format', '{{json .}}')
    try { $version = ($versionResult.text | ConvertFrom-Json -ErrorAction Stop) } catch {
        Fail-Gate 'INVALID_DOCKER_VERSION'
    }
    $script:DockerEvidence = [ordered]@{
        operatingSystem = [string]$info.OperatingSystem
        osType = [string]$info.OSType
        architecture = [string]$info.Architecture
        serverVersion = [string]$info.ServerVersion
        dockerRootDir = [string]$info.DockerRootDir
        clientVersion = [string]$version.Client.Version
        engineVersion = [string]$version.Server.Version
    }

    $containers = @(Invoke-Docker @('container', 'ls', '--all', '--format', '{{.Names}}')).text -split "`n"
    foreach ($name in @($script:Container, $script:RollbackContainer, $script:ProbeContainer)) {
        if ($containers -contains $name) { Fail-Gate 'FIXED_CONTAINER_ALREADY_EXISTS' }
    }
    $volumes = @(Invoke-Docker @('volume', 'ls', '--format', '{{.Name}}')).text -split "`n"
    foreach ($name in $script:VolumeNames) {
        if ($volumes -contains $name) { Fail-Gate 'FIXED_VOLUME_ALREADY_EXISTS' }
    }
    foreach ($imageRef in @(
            $script:CandidateRef, $script:HealthFailRef,
            $script:CandidateDigestRef, $script:HealthFailDigestRef
        )) {
        $existingImage = Invoke-Docker @('image', 'inspect', $imageRef) `
            -AllowFailure -SkipSecretScan
        if ($existingImage.exitCode -eq 0) { Fail-Gate 'CANDIDATE_IMAGE_REF_ALREADY_EXISTS' }
    }
    $dangling = (Invoke-Docker @('image', 'ls', '--filter', 'dangling=true', '--quiet')).text.Trim()
    if ($dangling) { Fail-Gate 'DANGLING_IMAGES_MUST_BE_EMPTY' }
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        Fail-Gate 'NETTCPIP_MODULE_REQUIRED'
    }
    if (Get-NetTCPConnection -LocalPort 28789 -State Listen -ErrorAction SilentlyContinue) {
        Fail-Gate 'FIXED_PORT_ALREADY_IN_USE'
    }
    $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $tempItem = Get-Item -LiteralPath $temp -Force
    if (-not $tempItem.PSIsContainer -or
        (($tempItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Fail-Gate 'INVALID_HOST_TEMP_ROOT'
    }
    $existingTemp = @(Get-ChildItem -LiteralPath $temp -Force -ErrorAction Stop |
        Where-Object { $_.Name -like 'rc-docker-install-*.log' -or
            $_.Name -like 'rc-bootstrap-installer.*' -or
            $_.Name -like 'rc-t10-volume-export-*' })
    if ($existingTemp.Count -ne 0) { Fail-Gate 'RC_TEMP_ARTIFACTS_MUST_BE_EMPTY' }
    $script:TempBaseline = @()
}

function Assert-ImageProvenance($ImageManifest, [string]$Ref, [bool]$HealthFail) {
    $digestRef = '{0}@{1}' -f $ImageManifest.repository, $ImageManifest.registryDigest
    $digestPull = Invoke-Docker @('pull', $digestRef)
    $digestPull.text = $null
    $digestInspectResult = Invoke-Docker @('image', 'inspect', $digestRef)
    try {
        $digestParsed = @($digestInspectResult.text | ConvertFrom-Json -ErrorAction Stop)
        if ($digestParsed.Count -ne 1) { Fail-Gate 'INVALID_IMAGE_INSPECT' }
        $digestInspect = $digestParsed[0]
    } catch {
        Fail-Gate 'INVALID_IMAGE_INSPECT'
    }
    if ($HealthFail) {
        $script:HealthFailCleanupImageId = [string]$digestInspect.Id
    } else {
        $script:CandidateCleanupImageId = [string]$digestInspect.Id
    }
    $tagPull = Invoke-Docker @('pull', $Ref)
    $tagPull.text = $null
    $inspectResult = Invoke-Docker @('image', 'inspect', $Ref)
    try {
        $parsed = @($inspectResult.text | ConvertFrom-Json -ErrorAction Stop)
        if ($parsed.Count -ne 1) { Fail-Gate 'INVALID_IMAGE_INSPECT' }
        $inspect = $parsed[0]
    } catch {
        Fail-Gate 'INVALID_IMAGE_INSPECT'
    }
    if ([string]$inspect.Id -cne [string]$digestInspect.Id) {
        Fail-Gate 'IMAGE_TAG_DIGEST_BINDING_MISMATCH'
    }
    if ($HealthFail) {
        $script:HealthFailImageInspect = $inspect
    } else {
        $script:CandidateImageInspect = $inspect
    }
    if ([string]$inspect.Os -cne 'linux' -or [string]$inspect.Architecture -cne 'amd64') {
        Fail-Gate 'IMAGE_PLATFORM_MISMATCH'
    }
    $expectedRepoDigest = '{0}@{1}' -f $ImageManifest.repository, $ImageManifest.registryDigest
    if (@($inspect.RepoDigests) -notcontains $expectedRepoDigest) {
        Fail-Gate 'IMAGE_REGISTRY_DIGEST_MISMATCH'
    }
    foreach ($property in $ImageManifest.labels.PSObject.Properties) {
        $actual = $inspect.Config.Labels.PSObject.Properties[$property.Name]
        if ($null -eq $actual -or [string]$actual.Value -cne [string]$property.Value) {
            Fail-Gate 'IMAGE_LABEL_MISMATCH'
        }
    }
    if ([string]$inspect.Config.Labels.'org.opencontainers.image.version' -cne
        $script:ExpectedVersion) {
        Fail-Gate 'IMAGE_VERSION_LABEL_MISMATCH'
    }
    if ($HealthFail -and
        [string]$inspect.Config.Labels.'ai.wentor.acceptance.failure-mode' -cne 'health-fail') {
        Fail-Gate 'HEALTH_FAIL_IMAGE_NOT_ATTESTED'
    }
    $versionEnvironment = @($inspect.Config.Env | Where-Object {
            ([string]$_).StartsWith('RC_BUILD_VERSION=', [StringComparison]::Ordinal)
        })
    $revisionEnvironment = @($inspect.Config.Env | Where-Object {
            ([string]$_).StartsWith('RC_BUILD_COMMIT=', [StringComparison]::Ordinal)
        })
    if ($versionEnvironment.Count -ne 1 -or $revisionEnvironment.Count -ne 1 -or
        [string]$versionEnvironment[0] -cne
            ('RC_BUILD_VERSION=' + [string]$ImageManifest.labels.'org.opencontainers.image.version') -or
        [string]$revisionEnvironment[0] -cne
            ('RC_BUILD_COMMIT=' + [string]$ImageManifest.labels.'org.opencontainers.image.revision')) {
        Fail-Gate 'IMAGE_BUILD_ENV_LABEL_MISMATCH'
    }
    return [ordered]@{
        reference = $Ref
        digestReference = $digestRef
        observedImageId = [string]$inspect.Id
        registryDigest = [string]$ImageManifest.registryDigest
        labels = $ImageManifest.labels
        buildEnvironmentMatchesLabels = $true
    }
}

function Assert-ImageReferenceId([string]$Ref, [string]$ExpectedImageId) {
    $result = Invoke-Docker @('image', 'inspect', $Ref)
    try {
        $parsed = @($result.text | ConvertFrom-Json -ErrorAction Stop)
        if ($parsed.Count -ne 1 -or
            [string]$parsed[0].Id -cne $ExpectedImageId) {
            Fail-Gate 'IMAGE_REFERENCE_CHANGED_DURING_SCENARIO'
        }
    } catch {
        if ([string]$_.Exception.Message -ceq 'IMAGE_REFERENCE_CHANGED_DURING_SCENARIO') {
            throw
        }
        Fail-Gate 'IMAGE_REFERENCE_CHANGED_DURING_SCENARIO'
    }
    return $true
}

function Get-StablePropertyJson($Value, [string[]]$Excluded) {
    $projection = [ordered]@{}
    foreach ($name in @($Value.PSObject.Properties.Name | Sort-Object)) {
        if ($Excluded -notcontains $name) { $projection[$name] = $Value.$name }
    }
    return ($projection | ConvertTo-Json -Depth 50 -Compress)
}

function Remove-OwnedProbeIfPresent {
    $inspectResult = Invoke-Docker @('container', 'inspect', $script:ProbeContainer) `
        -AllowFailure -SkipSecretScan
    if ($inspectResult.exitCode -ne 0) { return }
    try { $probe = @($inspectResult.text | ConvertFrom-Json -ErrorAction Stop)[0] } catch {
        Fail-Gate 'INVALID_PROBE_INSPECT'
    }
    if ([string]$probe.Config.Labels.'ai.wentor.acceptance.run-id' -cne $script:RunId) {
        Fail-Gate 'REFUSING_UNKNOWN_PROBE_CLEANUP'
    }
    Invoke-Docker @('container', 'rm', '--force', $script:ProbeContainer) | Out-Null
}

function Invoke-ImageHelper([string]$Ref, [string[]]$Command) {
    $arguments = @(
        'container', 'create', '--name', $script:ProbeContainer,
        '--label', ('ai.wentor.acceptance.run-id=' + $script:RunId),
        '--entrypoint', 'node',
        '-v', ('{0}:/acceptance/windows-volume-evidence.cjs:ro' -f
            $script:VolumeHelperResolved),
        $Ref, '/acceptance/windows-volume-evidence.cjs'
    ) + $Command
    $create = Invoke-Docker $arguments -AllowFailure
    if ($create.exitCode -ne 0) { Fail-Gate 'IMAGE_PARITY_PROBE_CREATE_FAILED' }
    $result = $null
    try {
        $probe = Get-ContainerInspect $script:ProbeContainer
        $helperMount = @($probe.Mounts | Where-Object {
                [string]$_.Destination -ceq '/acceptance/windows-volume-evidence.cjs'
            })
        if ([string]$probe.Config.Labels.'ai.wentor.acceptance.run-id' -cne $script:RunId -or
            $helperMount.Count -ne 1 -or [string]$helperMount[0].Type -cne 'bind' -or
            [bool]$helperMount[0].RW) {
            Fail-Gate 'IMAGE_PARITY_HELPER_BIND_INVALID'
        }
        $result = Invoke-Docker @('container', 'start', '--attach', $script:ProbeContainer) `
            -AllowFailure
    } finally {
        Remove-OwnedProbeIfPresent
    }
    if ($null -eq $result -or $result.exitCode -ne 0) { Fail-Gate 'IMAGE_PARITY_PROBE_FAILED' }
    return $result.text
}

function Get-CriticalRuntimeEvidence([string]$Ref, [AllowNull()][string]$ExtraPath) {
    $command = @('image-runtime')
    if ($ExtraPath) { $command += @('--extra-path', $ExtraPath) }
    $text = Invoke-ImageHelper $Ref $command
    try { $values = @($text | ConvertFrom-Json -ErrorAction Stop) } catch {
        Fail-Gate 'INVALID_IMAGE_PARITY_EVIDENCE'
    }
    $expectedCount = if ($ExtraPath) { 19 } else { 18 }
    if ($values.Count -ne $expectedCount) { Fail-Gate 'INCOMPLETE_IMAGE_PARITY_EVIDENCE' }
    return @($values)
}

function Assert-HealthFailImageParity {
    if ($null -eq $script:CandidateImageInspect -or $null -eq $script:HealthFailImageInspect) {
        Fail-Gate 'IMAGE_PARITY_INSPECT_MISSING'
    }
    $candidateEntrypoint = @($script:CandidateImageInspect.Config.Entrypoint)
    $healthEntrypoint = @($script:HealthFailImageInspect.Config.Entrypoint)
    if ($candidateEntrypoint.Count -ne 1 -or $candidateEntrypoint[0] -cne '/entrypoint.sh' -or
        $healthEntrypoint.Count -ne 1 -or $healthEntrypoint[0] -cne
            [string]$script:Manifest.images.healthFail.failureEntrypoint) {
        Fail-Gate 'IMAGE_ENTRYPOINT_PARITY_MISMATCH'
    }
    $candidateConfig = Get-StablePropertyJson $script:CandidateImageInspect.Config `
        @('Entrypoint', 'Labels')
    $healthConfig = Get-StablePropertyJson $script:HealthFailImageInspect.Config `
        @('Entrypoint', 'Labels')
    if ($candidateConfig -cne $healthConfig) { Fail-Gate 'IMAGE_CONFIG_PARITY_MISMATCH' }

    $candidateLabels = Get-StablePropertyJson $script:CandidateImageInspect.Config.Labels @()
    $healthLabels = Get-StablePropertyJson $script:HealthFailImageInspect.Config.Labels `
        @('ai.wentor.acceptance.failure-mode')
    if ($candidateLabels -cne $healthLabels) { Fail-Gate 'IMAGE_LABEL_PARITY_MISMATCH' }

    $candidateLayers = @($script:CandidateImageInspect.RootFS.Layers)
    $healthLayers = @($script:HealthFailImageInspect.RootFS.Layers)
    if ($candidateLayers.Count -lt 1 -or $healthLayers.Count -ne ($candidateLayers.Count + 1)) {
        Fail-Gate 'HEALTH_FAIL_IMAGE_LAYER_PARITY_MISMATCH'
    }
    for ($index = 0; $index -lt $candidateLayers.Count; $index++) {
        if ([string]$candidateLayers[$index] -cne [string]$healthLayers[$index]) {
            Fail-Gate 'HEALTH_FAIL_IMAGE_LAYER_PARITY_MISMATCH'
        }
    }

    $candidateRuntime = Get-CriticalRuntimeEvidence $script:CandidateRef $null
    $candidateRuntimeSha256 = Get-StringSha256 (
        $candidateRuntime | ConvertTo-Json -Depth 10 -Compress
    )
    if ($candidateRuntimeSha256 -cne
        [string]$script:Manifest.images.candidate.criticalRuntimeSha256) {
        Fail-Gate 'CANDIDATE_CRITICAL_RUNTIME_SHA256_MISMATCH'
    }
    $failureEntrypoint = [string]$script:Manifest.images.healthFail.failureEntrypoint
    $healthRuntime = Get-CriticalRuntimeEvidence $script:HealthFailRef $failureEntrypoint
    $healthCritical = @($healthRuntime | Where-Object { [string]$_.path -cne $failureEntrypoint })
    if (($candidateRuntime | ConvertTo-Json -Depth 10 -Compress) -cne
        ($healthCritical | ConvertTo-Json -Depth 10 -Compress)) {
        Fail-Gate 'CRITICAL_RUNTIME_BYTES_MISMATCH'
    }
    $failureEvidence = @($healthRuntime | Where-Object { [string]$_.path -ceq $failureEntrypoint })
    if ($failureEvidence.Count -ne 1 -or [string]$failureEvidence[0].sha256 -cne
        [string]$script:Manifest.images.healthFail.failureEntrypointSha256) {
        Fail-Gate 'HEALTH_FAIL_ENTRYPOINT_SHA256_MISMATCH'
    }
    $script:ImageParityEvidence = [ordered]@{
        configExceptEntrypointAndLabelsSha256 = Get-StringSha256 $candidateConfig
        labelsExceptFailureModeSha256 = Get-StringSha256 $candidateLabels
        candidateCriticalRuntime = $candidateRuntime
        candidateCriticalRuntimeSha256 = $candidateRuntimeSha256
        healthFailCriticalRuntime = $healthCritical
        failureEntrypoint = [ordered]@{
            path = $failureEntrypoint
            sha256 = [string]$failureEvidence[0].sha256
            size = [string]$failureEvidence[0].size
            mode = [int]$failureEvidence[0].mode
        }
        singleAdditionalLayerDigest = [string]$healthLayers[-1]
        exactCriticalRuntimeParity = $true
        configParity = $true
    }
}

function New-OwnedVolumes {
    foreach ($name in $script:VolumeNames) {
        $created = Invoke-Docker @(
            'volume', 'create',
            '--label', ('ai.wentor.acceptance.run-id=' + $script:RunId),
            '--label', 'ai.wentor.acceptance.owner=windows-bootstrap-docker',
            $name
        )
        if ($created.text.Trim() -cne $name) { Fail-Gate 'VOLUME_CREATE_FAILED' }
    }
    $script:GateMutated = $true
}

function Assert-OwnedVolume([string]$Name) {
    $result = Invoke-Docker @('volume', 'inspect', $Name)
    try {
        $parsed = @($result.text | ConvertFrom-Json -ErrorAction Stop)
        if ($parsed.Count -ne 1) { Fail-Gate 'INVALID_VOLUME_INSPECT' }
        $volume = $parsed[0]
    } catch { Fail-Gate 'INVALID_VOLUME_INSPECT' }
    if ([string]$volume.Name -cne $Name -or [string]$volume.Driver -cne 'local' -or
        [string]$volume.Labels.'ai.wentor.acceptance.run-id' -cne $script:RunId -or
        [string]$volume.Labels.'ai.wentor.acceptance.owner' -cne 'windows-bootstrap-docker') {
        Fail-Gate 'VOLUME_OWNERSHIP_MISMATCH'
    }
}

function Seed-UserOwnedVolumeMarkers {
    $mountArguments = @(
        '-v', 'rc-config:/app/config',
        '-v', 'rc-data:/app/.research-claw',
        '-v', 'rc-workspace:/app/workspace',
        '-v', 'rc-state:/root/.openclaw',
        '-v', ('{0}:/acceptance/windows-volume-evidence.cjs:ro' -f
            $script:VolumeHelperResolved)
    )
    $create = Invoke-Docker (@(
            'container', 'create', '--name', $script:ProbeContainer,
            '--label', ('ai.wentor.acceptance.run-id=' + $script:RunId),
            '--entrypoint', 'node'
        ) + $mountArguments + @(
            $script:CandidateRef,
            '/acceptance/windows-volume-evidence.cjs',
            'seed-user-markers', $script:RunId
        )) -AllowFailure
    if ($create.exitCode -ne 0) { Fail-Gate 'USER_MARKER_PROBE_CREATE_FAILED' }
    $result = $null
    try {
        $probe = Get-ContainerInspect $script:ProbeContainer
        if ([string]$probe.Config.Labels.'ai.wentor.acceptance.run-id' -cne $script:RunId) {
            Fail-Gate 'USER_MARKER_PROBE_OWNERSHIP_MISMATCH'
        }
        foreach ($volume in $script:VolumeNames) {
            $mount = @($probe.Mounts | Where-Object { [string]$_.Name -ceq $volume })
            if ($mount.Count -ne 1 -or [string]$mount[0].Type -cne 'volume' -or
                -not [bool]$mount[0].RW) { Fail-Gate 'USER_MARKER_VOLUME_NOT_WRITABLE' }
        }
        $helperMount = @($probe.Mounts | Where-Object {
                [string]$_.Destination -ceq '/acceptance/windows-volume-evidence.cjs'
            })
        if ($helperMount.Count -ne 1 -or [string]$helperMount[0].Type -cne 'bind' -or
            [bool]$helperMount[0].RW) { Fail-Gate 'USER_MARKER_HELPER_BIND_INVALID' }
        $result = Invoke-Docker @('container', 'start', '--attach', $script:ProbeContainer) `
            -AllowFailure
    } finally {
        Remove-OwnedProbeIfPresent
    }
    if ($null -eq $result -or $result.exitCode -ne 0) { Fail-Gate 'USER_MARKER_SEED_FAILED' }
    Assert-NoSecretText $result.text 'USER_MARKER_OUTPUT_SECRET_LEAK'
    try { $seeded = ($result.text | ConvertFrom-Json -ErrorAction Stop) } catch {
        Fail-Gate 'INVALID_USER_MARKER_SEED_EVIDENCE'
    }
    if ($seeded.schemaVersion -ne 1 -or @($seeded.seeded).Count -ne 4) {
        Fail-Gate 'INCOMPLETE_USER_MARKER_SEED'
    }
    $baseline = Get-VolumeEvidenceRaw 'none'
    if ([int]$baseline.userOwnedMarkerCount -ne 4) { Fail-Gate 'USER_MARKER_BASELINE_MISSING' }
    foreach ($marker in $baseline.userOwnedMarkers.PSObject.Properties) {
        $entries = @($marker.Value.entries)
        if ($entries.Count -ne 1 -or [string]$entries[0].type -cne 'file' -or
            [int]$entries[0].mode -ne 384) { Fail-Gate 'USER_MARKER_BASELINE_INVALID' }
    }
    $script:UserMarkerBaseline = [ordered]@{
        count = 4
        contentSha256 = [string]$baseline.userOwnedMarkersSha256
        observationSha256 = [string]$baseline.userOwnedMarkersObservationSha256
        markerPathSha256 = @($seeded.seeded | ForEach-Object { [string]$_.pathSha256 } |
            Sort-Object)
    }
}

function Invoke-ProbeContainer {
    param([string[]]$Command, [switch]$BindEvidenceHelper)
    $mountArguments = @(
        '-v', 'rc-config:/app/config:ro',
        '-v', 'rc-data:/app/.research-claw:ro',
        '-v', 'rc-workspace:/app/workspace:ro',
        '-v', 'rc-state:/root/.openclaw:ro'
    )
    if ($BindEvidenceHelper) {
        $mountArguments += @(
            '-v', ('{0}:/acceptance/windows-volume-evidence.cjs:ro' -f
                $script:VolumeHelperResolved)
        )
    }
    $arguments = @(
        'container', 'create', '--name', $script:ProbeContainer,
        '--label', ('ai.wentor.acceptance.run-id=' + $script:RunId),
        '--entrypoint', 'node'
    ) + $mountArguments + @($script:CandidateRef) + $Command
    $create = Invoke-Docker $arguments -AllowFailure
    if ($create.exitCode -ne 0) {
        Remove-OwnedProbeIfPresent
        Fail-Gate 'PROBE_CONTAINER_CREATE_FAILED'
    }
    $result = $null
    try {
        $probe = Get-ContainerInspect $script:ProbeContainer
        if ([string]$probe.Config.Labels.'ai.wentor.acceptance.run-id' -cne $script:RunId) {
            Fail-Gate 'PROBE_CONTAINER_OWNERSHIP_MISMATCH'
        }
        if ($BindEvidenceHelper) {
            foreach ($destination in @('/acceptance/windows-volume-evidence.cjs')) {
                $mount = @($probe.Mounts | Where-Object {
                        [string]$_.Destination -ceq $destination
                    })
                if ($mount.Count -ne 1 -or [string]$mount[0].Type -cne 'bind' -or
                    [bool]$mount[0].RW) {
                    Fail-Gate 'PROBE_SECRET_OR_HELPER_BIND_NOT_READ_ONLY'
                }
            }
        }
        $result = Invoke-Docker @('container', 'start', '--attach', $script:ProbeContainer) `
            -AllowFailure
    } finally {
        Remove-OwnedProbeIfPresent
    }
    if ($null -eq $result -or $result.exitCode -ne 0) { Fail-Gate 'PROBE_CONTAINER_FAILED' }
    return $result.text
}

function Initialize-HostVolumeSecretScanner {
    if ('RcT10HostVolumeSecretScanner' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

public sealed class RcT10SecretFinding
{
    public string Name { get; set; }
    public long Occurrences { get; set; }
    public string[] PathSha256 { get; set; }
}

public sealed class RcT10SecretScanResult
{
    public RcT10SecretFinding[] Findings { get; set; }
    public int FilesScanned { get; set; }
    public long BytesScanned { get; set; }
    public int ReparsePointsSkipped { get; set; }
}

public static class RcT10HostVolumeSecretScanner
{
    private sealed class Node
    {
        public readonly Dictionary<byte, int> Next = new Dictionary<byte, int>();
        public readonly List<int> Output = new List<int>();
        public int Fail;
    }

    private sealed class Work
    {
        public string Volume;
        public string FullPath;
        public string Relative;
    }

    private static string Sha256(string value)
    {
        using (SHA256 algorithm = SHA256.Create())
        {
            byte[] digest = algorithm.ComputeHash(new UTF8Encoding(false, true).GetBytes(value));
            StringBuilder text = new StringBuilder(digest.Length * 2);
            foreach (byte item in digest) text.Append(item.ToString("x2"));
            Array.Clear(digest, 0, digest.Length);
            return text.ToString();
        }
    }

    private static List<Node> BuildMachine(byte[][] patterns)
    {
        List<Node> nodes = new List<Node>();
        nodes.Add(new Node());
        for (int index = 0; index < patterns.Length; index++)
        {
            int state = 0;
            foreach (byte item in patterns[index])
            {
                int next;
                if (!nodes[state].Next.TryGetValue(item, out next))
                {
                    next = nodes.Count;
                    nodes[state].Next.Add(item, next);
                    nodes.Add(new Node());
                }
                state = next;
            }
            nodes[state].Output.Add(index);
        }
        Queue<int> queue = new Queue<int>();
        foreach (KeyValuePair<byte, int> edge in nodes[0].Next)
        {
            nodes[edge.Value].Fail = 0;
            queue.Enqueue(edge.Value);
        }
        while (queue.Count > 0)
        {
            int parent = queue.Dequeue();
            foreach (KeyValuePair<byte, int> edge in nodes[parent].Next)
            {
                int child = edge.Value;
                queue.Enqueue(child);
                int fallback = nodes[parent].Fail;
                int candidate;
                while (fallback != 0 && !nodes[fallback].Next.TryGetValue(edge.Key, out candidate))
                    fallback = nodes[fallback].Fail;
                if (nodes[fallback].Next.TryGetValue(edge.Key, out candidate) && candidate != child)
                    nodes[child].Fail = candidate;
                else
                    nodes[child].Fail = 0;
                nodes[child].Output.AddRange(nodes[nodes[child].Fail].Output);
            }
        }
        return nodes;
    }

    private static void ScanFile(string fullPath, string logicalHash, List<Node> nodes,
        long[] counts, HashSet<string>[] paths, ref long bytesScanned)
    {
        FileInfo before = new FileInfo(fullPath);
        before.Refresh();
        long length = before.Length;
        long modified = before.LastWriteTimeUtc.Ticks;
        FileAttributes attributes = before.Attributes;
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("HOST_SCAN_REPARSE_POINT");
        byte[] buffer = new byte[1024 * 1024];
        long observed = 0;
        int state = 0;
        using (FileStream stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read,
            FileShare.Read, buffer.Length, FileOptions.SequentialScan))
        {
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                observed += read;
                for (int offset = 0; offset < read; offset++)
                {
                    byte item = buffer[offset];
                    int next;
                    while (state != 0 && !nodes[state].Next.TryGetValue(item, out next))
                        state = nodes[state].Fail;
                    if (nodes[state].Next.TryGetValue(item, out next)) state = next;
                    else state = 0;
                    foreach (int match in nodes[state].Output)
                    {
                        if (counts[match] == long.MaxValue) throw new InvalidOperationException("HOST_SCAN_COUNT_OVERFLOW");
                        counts[match] += 1;
                        paths[match].Add(logicalHash);
                    }
                }
            }
        }
        Array.Clear(buffer, 0, buffer.Length);
        FileInfo after = new FileInfo(fullPath);
        after.Refresh();
        if (observed != length || after.Length != length || after.LastWriteTimeUtc.Ticks != modified
            || after.Attributes != attributes) throw new InvalidOperationException("HOST_SCAN_FILE_RACE");
        checked { bytesScanned += observed; }
    }

    public static RcT10SecretScanResult Scan(string exportRoot, string[] names, string[] values,
        long maxBytes, int maxFiles)
    {
        if (names == null || values == null || names.Length != values.Length || names.Length == 0)
            throw new InvalidOperationException("HOST_SCAN_INVALID_NEEDLES");
        UTF8Encoding utf8 = new UTF8Encoding(false, true);
        byte[][] patterns = new byte[values.Length][];
        for (int index = 0; index < values.Length; index++)
        {
            if (String.IsNullOrEmpty(names[index]) || String.IsNullOrEmpty(values[index]))
                throw new InvalidOperationException("HOST_SCAN_INVALID_NEEDLES");
            patterns[index] = utf8.GetBytes(values[index]);
        }
        List<Node> nodes = BuildMachine(patterns);
        long[] counts = new long[names.Length];
        HashSet<string>[] paths = new HashSet<string>[names.Length];
        for (int index = 0; index < paths.Length; index++) paths[index] = new HashSet<string>(StringComparer.Ordinal);
        Queue<Work> queue = new Queue<Work>();
        foreach (string volume in new string[] { "config", "data", "workspace", "state" })
        {
            string root = Path.Combine(exportRoot, volume);
            DirectoryInfo info = new DirectoryInfo(root);
            info.Refresh();
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("HOST_SCAN_INVALID_ROOT");
            queue.Enqueue(new Work { Volume = volume, FullPath = root, Relative = "." });
        }
        int filesScanned = 0;
        int reparsePointsSkipped = 0;
        long bytesScanned = 0;
        while (queue.Count > 0)
        {
            Work work = queue.Dequeue();
            string[] children = Directory.GetFileSystemEntries(work.FullPath);
            Array.Sort(children, StringComparer.Ordinal);
            foreach (string child in children)
            {
                FileAttributes attributes = File.GetAttributes(child);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                {
                    reparsePointsSkipped += 1;
                    continue;
                }
                string name = Path.GetFileName(child);
                string relative = work.Relative == "." ? name : work.Relative + "/" + name;
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    queue.Enqueue(new Work { Volume = work.Volume, FullPath = child, Relative = relative });
                    continue;
                }
                filesScanned += 1;
                if (filesScanned > maxFiles) throw new InvalidOperationException("HOST_SCAN_FILE_BUDGET");
                FileInfo file = new FileInfo(child);
                checked { if (bytesScanned + file.Length > maxBytes) throw new InvalidOperationException("HOST_SCAN_BYTE_BUDGET"); }
                string logicalHash = Sha256(work.Volume + "\0" + relative.Replace('\\', '/'));
                ScanFile(child, logicalHash, nodes, counts, paths, ref bytesScanned);
            }
        }
        RcT10SecretFinding[] findings = new RcT10SecretFinding[names.Length];
        for (int index = 0; index < names.Length; index++)
        {
            List<string> sorted = new List<string>(paths[index]);
            sorted.Sort(StringComparer.Ordinal);
            findings[index] = new RcT10SecretFinding {
                Name = names[index], Occurrences = counts[index], PathSha256 = sorted.ToArray()
            };
            Array.Clear(patterns[index], 0, patterns[index].Length);
        }
        Array.Clear(values, 0, values.Length);
        return new RcT10SecretScanResult {
            Findings = findings, FilesScanned = filesScanned, BytesScanned = bytesScanned,
            ReparsePointsSkipped = reparsePointsSkipped
        };
    }
}
'@
}

function New-PrivateVolumeExportRoot {
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    $target = Join-Path $tempRoot ('rc-t10-volume-export-' + $script:RunId)
    if (Test-Path -LiteralPath $target) { Fail-Gate 'VOLUME_EXPORT_ALREADY_EXISTS' }
    [System.IO.Directory]::CreateDirectory($target) | Out-Null
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity.User)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity.User,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
    Set-Acl -LiteralPath $target -AclObject $security
    return $target
}

function Remove-PrivateVolumeExportRoot([string]$Path) {
    if (-not $Path) { return }
    $full = [System.IO.Path]::GetFullPath($Path)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    if ([System.IO.Path]::GetDirectoryName($full).TrimEnd('\') -cne $tempRoot -or
        [System.IO.Path]::GetFileName($full) -cne ('rc-t10-volume-export-' + $script:RunId)) {
        Fail-Gate 'REFUSING_UNEXPECTED_VOLUME_EXPORT_CLEANUP'
    }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if (-not $item.PSIsContainer -or
            (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            Fail-Gate 'REFUSING_UNSAFE_VOLUME_EXPORT_CLEANUP'
        }
        Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $full) { Fail-Gate 'VOLUME_EXPORT_CLEANUP_FAILED' }
}

function Get-HostVolumeSecretScan([string]$ExpectedKey) {
    $exportRoot = $null
    $needleValues = $null
    try {
        $exportRoot = New-PrivateVolumeExportRoot
        $mounts = @(
            '-v', 'rc-config:/app/config:ro',
            '-v', 'rc-data:/app/.research-claw:ro',
            '-v', 'rc-workspace:/app/workspace:ro',
            '-v', 'rc-state:/root/.openclaw:ro'
        )
        $create = Invoke-Docker (@(
                'container', 'create', '--name', $script:ProbeContainer,
                '--label', ('ai.wentor.acceptance.run-id=' + $script:RunId),
                '--entrypoint', 'node'
            ) + $mounts + @(
                $script:CandidateRef, '/app/scripts/version-info.cjs', '--root', '/app'
            )) -AllowFailure
        if ($create.exitCode -ne 0) { Fail-Gate 'VOLUME_EXPORT_CONTAINER_CREATE_FAILED' }
        $probe = Get-ContainerInspect $script:ProbeContainer
        if ([string]$probe.Config.Labels.'ai.wentor.acceptance.run-id' -cne $script:RunId) {
            Fail-Gate 'VOLUME_EXPORT_CONTAINER_OWNERSHIP_MISMATCH'
        }
        foreach ($volume in $script:VolumeNames) {
            $mount = @($probe.Mounts | Where-Object { [string]$_.Name -ceq $volume })
            if ($mount.Count -ne 1 -or [string]$mount[0].Type -cne 'volume' -or
                [bool]$mount[0].RW) { Fail-Gate 'VOLUME_EXPORT_MOUNT_NOT_READ_ONLY' }
        }
        $mapping = [ordered]@{
            config = '/app/config'
            data = '/app/.research-claw'
            workspace = '/app/workspace'
            state = '/root/.openclaw'
        }
        foreach ($name in $mapping.Keys) {
            $target = Join-Path $exportRoot $name
            [System.IO.Directory]::CreateDirectory($target) | Out-Null
            $source = '{0}:{1}/.' -f $script:ProbeContainer, $mapping[$name]
            $copy = Invoke-Docker @('container', 'cp', $source, $target) -AllowFailure
            if ($copy.exitCode -ne 0) { Fail-Gate 'VOLUME_EXPORT_FAILED' }
        }
        Remove-OwnedProbeIfPresent
        Initialize-HostVolumeSecretScanner
        $needleNames = @(
            'token:network', 'token:unknown', 'token:revoked', 'token:badCapsule',
            'token:valid', 'token:rotate', 'token:healthFail',
            'modelKey:badCapsule', 'modelKey:valid', 'modelKey:rotate', 'modelKey:healthFail'
        )
        $needleValues = @(
            [string]$script:Secrets.tokens.network,
            [string]$script:Secrets.tokens.unknown,
            [string]$script:Secrets.tokens.revoked,
            [string]$script:Secrets.tokens.badCapsule,
            [string]$script:Secrets.tokens.valid,
            [string]$script:Secrets.tokens.rotate,
            [string]$script:Secrets.tokens.healthFail,
            [string]$script:Secrets.modelKeys.badCapsule,
            [string]$script:Secrets.modelKeys.valid,
            [string]$script:Secrets.modelKeys.rotate,
            [string]$script:Secrets.modelKeys.healthFail
        )
        try {
            $hostResult = [RcT10HostVolumeSecretScanner]::Scan(
                $exportRoot, $needleNames, $needleValues, 17179869184, 100000
            )
        } catch {
            Fail-Gate 'HOST_VOLUME_SECRET_SCAN_FAILED'
        }
        $tokenFindings = New-Object System.Collections.ArrayList
        $keyFindings = New-Object System.Collections.ArrayList
        $canonical = Get-StringSha256 ('state' + [char]0 +
            'agents/main/agent/auth-profiles.json')
        foreach ($finding in $hostResult.Findings) {
            $parts = ([string]$finding.Name).Split(':')
            $paths = @($finding.PathSha256)
            $item = [ordered]@{
                name = $parts[1]
                occurrences = [int64]$finding.Occurrences
                pathSha256 = $paths
                canonicalOnly = ([int64]$finding.Occurrences -gt 0 -and
                    $paths.Count -eq 1 -and [string]$paths[0] -ceq $canonical)
            }
            if ($parts[0] -ceq 'token') { [void]$tokenFindings.Add($item) }
            else { [void]$keyFindings.Add($item) }
        }
        return [pscustomobject][ordered]@{
            expectedKey = $ExpectedKey
            policyPass = $true
            canonicalAuthPathSha256 = $canonical
            tokenOccurrences = @($tokenFindings)
            modelKeyOccurrences = @($keyFindings)
            filesScanned = [int]$hostResult.FilesScanned
            bytesScanned = [int64]$hostResult.BytesScanned
            reparsePointsSkipped = [int]$hostResult.ReparsePointsSkipped
            source = 'acl-private-host-export'
            secretBundleMountedIntoContainer = $false
        }
    } finally {
        $needleValues = $null
        $probeCleanupFailed = $false
        $exportCleanupFailed = $false
        try { Remove-OwnedProbeIfPresent } catch { $probeCleanupFailed = $true }
        try { Remove-PrivateVolumeExportRoot $exportRoot } catch { $exportCleanupFailed = $true }
        [GC]::Collect()
        if ($exportCleanupFailed) { Fail-Gate 'VOLUME_EXPORT_PRIVATE_DATA_CLEANUP_FAILED' }
        if ($probeCleanupFailed) { Fail-Gate 'VOLUME_EXPORT_PROBE_CLEANUP_FAILED' }
    }
}

function Assert-VolumeSecretPolicy($Scan, [string]$ExpectedKey) {
    if ($null -eq $Scan -or [string]$Scan.expectedKey -cne $ExpectedKey -or
        $Scan.policyPass -ne $true) {
        Fail-Gate 'VOLUME_SECRET_POLICY_FAILED'
    }
    $canonical = Get-StringSha256 ('state' + [char]0 +
        'agents/main/agent/auth-profiles.json')
    if ([string]$Scan.canonicalAuthPathSha256 -cne $canonical) {
        Fail-Gate 'VOLUME_SECRET_POLICY_CANONICAL_PATH_MISMATCH'
    }
    $tokenNames = @('network', 'unknown', 'revoked', 'badCapsule', 'valid', 'rotate', 'healthFail')
    $tokens = @($Scan.tokenOccurrences)
    if ($tokens.Count -ne $tokenNames.Count) { Fail-Gate 'VOLUME_SECRET_POLICY_INCOMPLETE' }
    foreach ($name in $tokenNames) {
        $entry = @($tokens | Where-Object { [string]$_.name -ceq $name })
        if ($entry.Count -ne 1 -or [int64]$entry[0].occurrences -ne 0 -or
            @($entry[0].pathSha256).Count -ne 0 -or [bool]$entry[0].canonicalOnly) {
            Fail-Gate 'TOKEN_PERSISTED_TO_VOLUME'
        }
    }
    $keyNames = @('badCapsule', 'valid', 'rotate', 'healthFail')
    $keys = @($Scan.modelKeyOccurrences)
    if ($keys.Count -ne $keyNames.Count) { Fail-Gate 'VOLUME_SECRET_POLICY_INCOMPLETE' }
    foreach ($name in $keyNames) {
        $entry = @($keys | Where-Object { [string]$_.name -ceq $name })
        if ($entry.Count -ne 1) { Fail-Gate 'VOLUME_SECRET_POLICY_INCOMPLETE' }
        if ($ExpectedKey -cne 'none' -and $name -ceq $ExpectedKey) {
            if ([int64]$entry[0].occurrences -ne 1 -or -not [bool]$entry[0].canonicalOnly -or
                @($entry[0].pathSha256).Count -ne 1 -or
                [string]$entry[0].pathSha256[0] -cne $canonical) {
                Fail-Gate 'CURRENT_MODEL_KEY_VOLUME_POLICY_FAILED'
            }
        } elseif ([int64]$entry[0].occurrences -ne 0 -or
            @($entry[0].pathSha256).Count -ne 0 -or [bool]$entry[0].canonicalOnly) {
            Fail-Gate 'STALE_MODEL_KEY_PERSISTED_TO_VOLUME'
        }
    }
}

function Get-VolumeEvidenceRaw([string]$ExpectedKey) {
    if (@('none', 'valid', 'rotate') -notcontains $ExpectedKey) {
        Fail-Gate 'INVALID_EXPECTED_VOLUME_KEY'
    }
    $text = Invoke-ProbeContainer @('/acceptance/windows-volume-evidence.cjs') `
        -BindEvidenceHelper
    Assert-NoSecretText $text 'VOLUME_EVIDENCE_SECRET_LEAK'
    try { $evidence = ($text | ConvertFrom-Json -ErrorAction Stop) } catch {
        Fail-Gate 'INVALID_VOLUME_EVIDENCE'
    }
    $secretScan = Get-HostVolumeSecretScan $ExpectedKey
    Assert-VolumeSecretPolicy $secretScan $ExpectedKey
    $evidence | Add-Member -NotePropertyName secretScan -NotePropertyValue $secretScan
    return $evidence
}

function Get-VolumeEvidence([string]$ExpectedKey) {
    # Freeze the gate-owned gateway briefly so SQLite/WAL bytes form one
    # repeatable observation point. The container ID and volume identities do
    # not change; unpause is mandatory even when the helper rejects evidence.
    $before = Get-ContainerInspect $script:Container
    if (-not $before.State.Running) { Fail-Gate 'GATEWAY_NOT_RUNNING_BEFORE_VOLUME_SCAN' }
    $containerId = [string]$before.Id
    $evidence = $null
    Invoke-Docker @('container', 'pause', $script:Container) | Out-Null
    try {
        $evidence = Get-VolumeEvidenceRaw $ExpectedKey
    } finally {
        Invoke-Docker @('container', 'unpause', $script:Container) | Out-Null
    }
    $after = Get-ContainerInspect $script:Container
    if ([string]$after.Id -cne $containerId -or -not $after.State.Running -or
        -not (Test-GatewayHealthy)) {
        Fail-Gate 'GATEWAY_NOT_HEALTHY_AFTER_VOLUME_SCAN'
    }
    return $evidence
}

function Get-ProfileStatus {
    $text = Invoke-ProbeContainer @(
        '/app/scripts/apply-bootstrap-profile.cjs', 'status',
        '--rc-root', '/app',
        '--config', '/app/config/openclaw.json',
        '--workspace', '/app/workspace',
        '--state-dir', '/root/.openclaw',
        '--db', '/app/.research-claw/library.db',
        '--global-config', '/root/.openclaw/openclaw.json'
    )
    Assert-NoSecretText $text 'PROFILE_STATUS_SECRET_LEAK'
    try { return ($text | ConvertFrom-Json -ErrorAction Stop) } catch {
        Fail-Gate 'INVALID_PROFILE_STATUS'
    }
}

function Test-GatewayHealthy {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:28789/healthz' `
            -UseBasicParsing -TimeoutSec 5
        return $response.StatusCode -eq 200
    } catch { return $false }
}

function Get-ContainerInspect([string]$Name) {
    $result = Invoke-Docker @('container', 'inspect', $Name)
    try {
        $parsed = @($result.text | ConvertFrom-Json -ErrorAction Stop)
        if ($parsed.Count -ne 1) { Fail-Gate 'INVALID_CONTAINER_INSPECT' }
        return $parsed[0]
    } catch { Fail-Gate 'INVALID_CONTAINER_INSPECT' }
}

function Get-StableState([string]$ExpectedKey) {
    $container = Get-ContainerInspect $script:Container
    if (-not $container.State.Running -or -not (Test-GatewayHealthy)) {
        Fail-Gate 'GATEWAY_NOT_HEALTHY'
    }
    $mounts = @($container.Mounts | Where-Object { $_.Type -eq 'volume' } |
        ForEach-Object { [string]$_.Name } | Sort-Object)
    if (($mounts -join "`n") -cne (@($script:VolumeNames | Sort-Object) -join "`n")) {
        Fail-Gate 'CONTAINER_VOLUME_TOPOLOGY_MISMATCH'
    }
    $status = Get-ProfileStatus
    if ($null -ne $status.pendingTransaction) { Fail-Gate 'PENDING_PROFILE_TRANSACTION' }
    $volume = Get-VolumeEvidence $ExpectedKey
    if (($null -eq $status.profile) -ne ($null -eq $volume.profile) -or
        ($null -ne $status.profile -and (
            [string]$status.profile.id -cne [string]$volume.profile.id -or
            [int]$status.profile.revision -ne [int]$volume.profile.revision -or
            [string]$status.profile.digest -cne [string]$volume.profile.digest))) {
        Fail-Gate 'PROFILE_STATUS_RECEIPT_MISMATCH'
    }
    if ([int]$volume.activeTransactionMarkerCount -ne 0) {
        Fail-Gate 'ACTIVE_TRANSACTION_MARKERS_REMAIN'
    }
    if ($null -eq $script:UserMarkerBaseline -or
        [int]$volume.userOwnedMarkerCount -ne 4 -or
        [string]$volume.userOwnedMarkersSha256 -cne
            [string]$script:UserMarkerBaseline.contentSha256 -or
        [string]$volume.userOwnedMarkersObservationSha256 -cne
            [string]$script:UserMarkerBaseline.observationSha256) {
        Fail-Gate 'USER_OWNED_VOLUME_MARKER_CHANGED'
    }
    return [pscustomobject][ordered]@{
        containerId = [string]$container.Id
        imageId = [string]$container.Image
        healthy = $true
        profile = $status.profile
        volume = $volume
    }
}

function Assert-ExpectedProfile($Actual, $Expected) {
    if ($null -eq $Expected) {
        if ($null -ne $Actual) { Fail-Gate 'UNEXPECTED_PROFILE_STATUS' }
        return
    }
    if ($null -eq $Actual -or
        [string]$Actual.id -cne [string]$Expected.id -or
        [int]$Actual.revision -ne [int]$Expected.revision -or
        [string]$Actual.digest -cne [string]$Expected.digest) {
        Fail-Gate 'PROFILE_STATUS_MISMATCH'
    }
}

function Assert-ProtectedStateUnchanged {
    param($Before, $After, [bool]$RequireObservation)
    if ([string]$Before.containerId -cne [string]$After.containerId -or
        [string]$Before.volume.declaredWriteSetSha256 -cne
            [string]$After.volume.declaredWriteSetSha256 -or
        [int]$After.volume.activeTransactionMarkerCount -ne 0) {
        Fail-Gate 'PROTECTED_STATE_CHANGED'
    }
    if ($RequireObservation -and
        [string]$Before.volume.declaredWriteSetObservationSha256 -cne
            [string]$After.volume.declaredWriteSetObservationSha256) {
        Fail-Gate 'PROTECTED_STATE_OBSERVATION_CHANGED'
    }
    $beforeProfile = if ($null -eq $Before.profile) { 'null' } else {
        $Before.profile | ConvertTo-Json -Compress
    }
    $afterProfile = if ($null -eq $After.profile) { 'null' } else {
        $After.profile | ConvertTo-Json -Compress
    }
    if ($beforeProfile -cne $afterProfile) { Fail-Gate 'PROFILE_STATUS_CHANGED' }
}

function New-LoopbackRejectingProxy {
    if (-not ('RcT10RejectingProxy' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

public sealed class RcT10RejectingProxy : IDisposable
{
    private readonly TcpListener listener;
    private readonly Thread worker;
    private volatile bool observed;
    private volatile bool redeemObserved;
    private int connectionCount;

    public RcT10RejectingProxy()
    {
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(16);
        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        worker = new Thread(Run);
        worker.IsBackground = true;
        worker.Name = "rc-t10-rejecting-proxy";
        worker.Start();
    }

    public int Port { get; private set; }
    public bool Observed { get { return observed; } }
    public bool RedeemObserved { get { return redeemObserved; } }
    public int ConnectionCount { get { return connectionCount; } }

    private void Run()
    {
        while (true)
        {
            try
            {
                using (TcpClient client = listener.AcceptTcpClient())
                {
                    observed = true;
                    Interlocked.Increment(ref connectionCount);
                    client.ReceiveTimeout = 2000;
                    byte[] buffer = new byte[4096];
                    int total = 0;
                    try
                    {
                        NetworkStream stream = client.GetStream();
                        while (total < buffer.Length)
                        {
                            int read = stream.Read(buffer, total, buffer.Length - total);
                            if (read <= 0) break;
                            total += read;
                            string prefix = Encoding.ASCII.GetString(buffer, 0, total);
                            if (prefix.IndexOf("\r\n", StringComparison.Ordinal) >= 0) break;
                        }
                    }
                    catch (System.IO.IOException) { }
                    if (total > 0)
                    {
                        string request = Encoding.ASCII.GetString(buffer, 0, total);
                        if (request.IndexOf("wentor.ai:443", StringComparison.OrdinalIgnoreCase) >= 0)
                            redeemObserved = true;
                    }
                }
            }
            catch (SocketException) { break; }
            catch (ObjectDisposedException) { break; }
        }
        try { listener.Stop(); } catch { }
    }

    public void Dispose()
    {
        try { listener.Stop(); } catch { }
        if (worker != null && worker.IsAlive) worker.Join(TimeSpan.FromSeconds(5));
    }
}
'@
    }
    return New-Object RcT10RejectingProxy
}

function Set-LoopbackFailureProxy([int]$Port) {
    $uri = 'http://127.0.0.1:{0}' -f $Port
    $proxy = New-Object System.Net.WebProxy($uri, $false)
    [System.Net.WebRequest]::DefaultWebProxy = $proxy
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
            'http_proxy', 'https_proxy', 'all_proxy')) {
        [System.Environment]::SetEnvironmentVariable($name, $uri, 'Process')
    }
    foreach ($name in @('NO_PROXY', 'no_proxy')) {
        [System.Environment]::SetEnvironmentVariable($name, '', 'Process')
    }
}

function Restore-ProxyState {
    [System.Net.WebRequest]::DefaultWebProxy = $script:OriginalDefaultProxy
    foreach ($name in $script:OriginalProxy.Keys) {
        [System.Environment]::SetEnvironmentVariable(
            $name, $script:OriginalProxy[$name], 'Process'
        )
    }
}

function Get-FailureCategory([string]$Message) {
    if ($Message -like '*invalid format*' -or $Message -like '*requires a non-empty value*') {
        return 'invalid-arguments'
    }
    if ($Message -like '*redemption returned HTTP 401*') { return 'redemption-http-401' }
    if ($Message -like "*operation 'stage' failed*") { return 'capsule-stage-rejected' }
    if ($Message -like '*gateway did not become ready*') { return 'replacement-health-timeout' }
    if ($Message -like '*exited before becoming ready*') { return 'replacement-crash-before-health' }
    if ($Message -like '*container could not be started*') { return 'replacement-start-failed' }
    if ($Message -like '*sending the request*' -or $Message -like '*connect*' -or
        $Message -like '*proxy*' -or $Message -like '*name could not be resolved*') {
        return 'network-failed'
    }
    return 'unclassified-failure'
}

function Get-SafeFailureCode([string]$Message, [string]$Fallback) {
    if ($Message -match '^[A-Z][A-Z0-9_]{2,127}$') { return $Message }
    return $Fallback
}

function Add-CapsuleRedemptionAttestation {
    param(
        [string]$Scenario,
        [string]$Token,
        [AllowNull()]$Expected,
        [string]$ExpectedCapsuleDigest,
        [AllowNull()][object]$ExpectedModelKey
    )
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.AutomaticDecompression = [System.Net.DecompressionMethods]::None
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::Post,
        $script:ExpectedRedeemEndpoint
    )
    [void]$request.Headers.TryAddWithoutValidation('Authorization', "Bearer $Token")
    [void]$request.Headers.TryAddWithoutValidation('Accept-Encoding', 'identity')
    $response = $null
    $bytes = $null
    $text = $null
    $capsule = $null
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200) { Fail-Gate 'CAPSULE_ATTESTATION_REDEMPTION_FAILED' }
        $contentType = $response.Content.Headers.ContentType
        $encoding = @($response.Content.Headers.ContentEncoding)
        $length = $response.Content.Headers.ContentLength
        if (-not $contentType -or $contentType.MediaType -ine 'application/json' -or
            $contentType.CharSet -ine 'utf-8' -or $contentType.Parameters.Count -ne 1 -or
            $encoding.Count -ne 1 -or $encoding[0] -ine 'identity' -or
            $null -eq $length -or $length -le 0 -or $length -gt 2097152 -or
            -not $response.Headers.CacheControl.NoStore) {
            Fail-Gate 'CAPSULE_ATTESTATION_RESPONSE_METADATA_INVALID'
        }
        $response.Content.LoadIntoBufferAsync(2097152).GetAwaiter().GetResult()
        $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        if ($bytes.Length -ne $length) { Fail-Gate 'CAPSULE_ATTESTATION_BYTES_INVALID' }
        $digest = Get-BytesSha256 $bytes
        $text = $script:Utf8NoBom.GetString($bytes)
        try { $capsule = ($text | ConvertFrom-Json -ErrorAction Stop) } catch {
            Fail-Gate 'CAPSULE_ATTESTATION_JSON_INVALID'
        }
        Assert-ExactProperties $capsule @(
            'schemaVersion', 'profile', 'model', 'secrets', 'policy', 'skills'
        ) 'CAPSULE_ATTESTATION_SCHEMA_INVALID'
        Assert-ExactProperties $capsule.profile @(
            'id', 'revision', 'requiredRcVersion'
        ) 'CAPSULE_ATTESTATION_SCHEMA_INVALID'
        Assert-ExactProperties $capsule.secrets @('modelApiKey') `
            'CAPSULE_ATTESTATION_SCHEMA_INVALID'
        if (-not (Test-JsonIntegerOne $capsule.schemaVersion) -or
            -not (Test-JsonString $capsule.profile.id) -or
            $null -eq $capsule.profile.revision -or
            @('Int32', 'Int64') -notcontains $capsule.profile.revision.GetType().Name -or
            -not (Test-JsonString $capsule.profile.requiredRcVersion) -or
            [string]$capsule.profile.requiredRcVersion -cne $script:ExpectedVersion -or
            $ExpectedCapsuleDigest -notmatch '^[0-9a-f]{64}$' -or
            $digest -cne $ExpectedCapsuleDigest) {
            Fail-Gate 'CAPSULE_ATTESTATION_PROFILE_MISMATCH'
        }
        if ($null -ne $Expected -and (
            [string]$capsule.profile.id -cne [string]$Expected.id -or
            [int]$capsule.profile.revision -ne [int]$Expected.revision)) {
            Fail-Gate 'CAPSULE_ATTESTATION_PROFILE_MISMATCH'
        }
        if (-not (Test-SecretStringEqual $capsule.secrets.modelApiKey $ExpectedModelKey)) {
            Fail-Gate 'CAPSULE_ATTESTATION_MODEL_KEY_MISMATCH'
        }
        [void]$script:CapsuleAttestations.Add([ordered]@{
            scenario = $Scenario
            statusCode = 200
            bytes = $bytes.Length
            capsuleSha256 = $digest
            profile = [ordered]@{
                id = [string]$capsule.profile.id
                revision = [int]$capsule.profile.revision
                requiredRcVersion = [string]$capsule.profile.requiredRcVersion
            }
            cacheControlNoStore = $true
            modelKeyBinding = $true
            tokenTransport = 'gate-owned-in-process-http-authorization-header'
            nonLeakProof = 'sha256-pinned-acceptance-harness-source-contract'
        })
    } catch {
        if ([string]$_.Exception.Message -match '^[A-Z][A-Z0-9_]{2,127}$') { throw }
        Fail-Gate 'CAPSULE_ATTESTATION_REQUEST_FAILED'
    } finally {
        if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        $capsule = $null
        $text = $null
        $Token = $null
        $ExpectedModelKey = $null
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
}

function Invoke-ProductionInstaller {
    param(
        [string]$Scenario,
        [AllowNull()][string]$Token,
        [bool]$TokenSupplied,
        [string]$ImageRepository,
        [bool]$NetworkFault
    )
    $env:MIRROR = $ImageRepository
    $output = New-Object System.Collections.ArrayList
    $succeeded = $false
    $message = ''
    $rejectingProxy = $null
    $networkFaultObserved = $false
    $networkProxyConnections = 0
    try {
        if ($NetworkFault) {
            $rejectingProxy = New-LoopbackRejectingProxy
            Set-LoopbackFailureProxy $rejectingProxy.Port
        }
        if ($TokenSupplied) {
            & $script:InstallerScriptBlock -AuthToken $Token *>&1 |
                ForEach-Object { [void]$output.Add([string]$_) }
        } else {
            & $script:InstallerScriptBlock *>&1 |
                ForEach-Object { [void]$output.Add([string]$_) }
        }
        $succeeded = $true
    } catch {
        $message = [string]$_.Exception.Message
    } finally {
        if ($NetworkFault) {
            if ($rejectingProxy) {
                $networkFaultObserved = [bool]$rejectingProxy.RedeemObserved
                $networkProxyConnections = [int]$rejectingProxy.ConnectionCount
                $rejectingProxy.Dispose()
            }
            Restore-ProxyState
        }
        $Token = $null
    }
    $text = @($output) -join "`n"
    Assert-NoSecretText ($text + "`n" + $message) 'INSTALLER_OUTPUT_SECRET_LEAK'
    $category = if ($succeeded) { 'success' } else { Get-FailureCategory $message }
    $result = [pscustomobject][ordered]@{
        scenario = $Scenario
        invocation = 'in-process-dynamic-scriptblock'
        resultCode = if ($succeeded) { 0 } else { 1 }
        category = $category
        outputSha256 = Get-StringSha256 $text
        outputCharacters = $text.Length
        secretFree = $true
        networkFaultObserved = $networkFaultObserved
        networkProxyConnections = $networkProxyConnections
    }
    $text = $null
    $message = $null
    $output.Clear()
    return $result
}

function Get-NewTempArtifacts {
    $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    return @(Get-ChildItem -LiteralPath $temp -Force -ErrorAction Stop |
        Where-Object { $_.Name -like 'rc-docker-install-*.log' -or
            $_.Name -like 'rc-bootstrap-installer.*' -or
            $_.Name -like 'rc-t10-volume-export-*' })
}

function Scan-AndRemoveTempArtifacts([string]$Scenario) {
    $evidence = New-Object System.Collections.ArrayList
    $secretLeak = $false
    $invalidArtifact = $false
    $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    foreach ($item in Get-NewTempArtifacts) {
        $full = [System.IO.Path]::GetFullPath($item.FullName)
        if ((Split-Path -Parent $full).TrimEnd('\') -cne $temp -or
            ($item.Name -notlike 'rc-docker-install-*.log' -and
                $item.Name -notlike 'rc-bootstrap-installer.*' -and
                $item.Name -notlike 'rc-t10-volume-export-*') -or
            (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            Fail-Gate 'UNSAFE_TEMP_ARTIFACT'
        }
        if ($item.PSIsContainer) {
            $children = @(Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction Stop)
            if (@($children | Where-Object {
                    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
                }).Count -ne 0) {
                Fail-Gate 'UNSAFE_TEMP_ARTIFACT'
            }
            foreach ($file in $children | Where-Object { -not $_.PSIsContainer }) {
                if ($file.Length -gt 16MB) {
                    $invalidArtifact = $true
                    continue
                }
                $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
                if (Test-BytesContainSecret $bytes) { $secretLeak = $true }
                [void]$evidence.Add([ordered]@{
                    nameSha256 = Get-StringSha256 $file.Name
                    size = $bytes.Length
                    sha256 = Get-BytesSha256 $bytes
                })
            }
        } else {
            if ($item.Length -gt 16MB) {
                $invalidArtifact = $true
            } else {
                $bytes = [System.IO.File]::ReadAllBytes($full)
                if (Test-BytesContainSecret $bytes) { $secretLeak = $true }
                [void]$evidence.Add([ordered]@{
                    nameSha256 = Get-StringSha256 $item.Name
                    size = $bytes.Length
                    sha256 = Get-BytesSha256 $bytes
                })
            }
        }
        Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $full) { Fail-Gate 'HOST_TEMP_CLEANUP_FAILED' }
    }
    if ($secretLeak) { Fail-Gate 'HOST_TEMP_SECRET_LEAK' }
    if ($invalidArtifact) { Fail-Gate 'UNSAFE_TEMP_ARTIFACT' }
    return @($evidence)
}

function Invoke-RuntimeSecretScan([string]$Scenario) {
    $hashes = New-Object System.Collections.ArrayList
    $mainContainerObserved = $false
    foreach ($name in @($script:Container, $script:RollbackContainer, $script:ProbeContainer)) {
        $inspect = Invoke-Docker @('container', 'inspect', $name) -AllowFailure
        if ($inspect.exitCode -eq 0) {
            if ($name -ceq $script:Container) { $mainContainerObserved = $true }
            Assert-NoSecretText $inspect.text 'DOCKER_INSPECT_SECRET_LEAK'
            [void]$hashes.Add([ordered]@{
                kind = 'inspect'; name = $name; exitCode = $inspect.exitCode; sha256 = $inspect.sha256
            })
            $logs = Invoke-Docker @('container', 'logs', $name) -AllowFailure
            if ($logs.exitCode -ne 0) { Fail-Gate 'DOCKER_LOG_SCAN_FAILED' }
            Assert-NoSecretText $logs.text 'DOCKER_LOG_SECRET_LEAK'
            [void]$hashes.Add([ordered]@{
                kind = 'logs'; name = $name; exitCode = $logs.exitCode; sha256 = $logs.sha256
            })
            $top = Invoke-Docker @('container', 'top', $name, '-eo', 'pid,args') -AllowFailure
            if ($top.exitCode -ne 0) { Fail-Gate 'DOCKER_PROCESS_SCAN_FAILED' }
            Assert-NoSecretText $top.text 'DOCKER_PROCESS_SECRET_LEAK'
            [void]$hashes.Add([ordered]@{
                kind = 'top'; name = $name; exitCode = $top.exitCode; sha256 = $top.sha256
            })
        } else {
            [void]$hashes.Add([ordered]@{
                kind = 'absent'; name = $name; inspectExitCode = $inspect.exitCode
            })
        }
    }
    if (-not $mainContainerObserved) { Fail-Gate 'MAIN_CONTAINER_SECRET_SCAN_MISSING' }
    $processCount = 0
    foreach ($process in Get-CimInstance Win32_Process -ErrorAction Stop) {
        $processCount += 1
        Assert-NoSecretText ([string]$process.CommandLine) 'HOST_PROCESS_SECRET_LEAK'
    }
    $tempArtifacts = Scan-AndRemoveTempArtifacts $Scenario
    $scan = [ordered]@{
        scenario = $Scenario
        dockerArtifacts = @($hashes)
        hostProcessesScanned = $processCount
        hostTempArtifacts = $tempArtifacts
        observationMode = 'posthoc-surviving-containers-current-host-processes-and-host-temp'
        transientNonLeakProof = 'sha256-pinned-installer-secret-flow-contract'
        secretFree = $true
    }
    [void]$script:RuntimeScans.Add($scan)
}

function Add-Scenario {
    param($Invocation, $State, [string]$Assertion)
    [void]$script:ScenarioResults.Add([ordered]@{
        name = $Invocation.scenario
        resultCode = $Invocation.resultCode
        category = $Invocation.category
        invocation = $Invocation.invocation
        outputSha256 = $Invocation.outputSha256
        outputCharacters = $Invocation.outputCharacters
        secretFree = $Invocation.secretFree
        networkFaultObserved = $Invocation.networkFaultObserved
        networkProxyConnections = $Invocation.networkProxyConnections
        assertion = $Assertion
        state = [ordered]@{
            containerId = $State.containerId
            imageId = $State.imageId
            healthy = $State.healthy
            profile = $State.profile
            volumeEvidence = $State.volume
        }
    })
}

function Run-AcceptanceScenarios {
    # 1. Ordinary fresh and rerun paths.
    $invoke = Invoke-ProductionInstaller 'no-token-fresh' $null $false `
        ([string]$script:Manifest.images.candidate.repository) $false
    if ($invoke.resultCode -ne 0) { Fail-Gate 'NO_TOKEN_FRESH_FAILED' }
    $state = Get-StableState 'none'
    if ($state.imageId -cne $script:CandidateImageId) { Fail-Gate 'CANDIDATE_CONTAINER_IMAGE_MISMATCH' }
    Assert-ExpectedProfile $state.profile $null
    Invoke-RuntimeSecretScan 'no-token-fresh'
    Add-Scenario $invoke $state 'healthy ordinary fresh; no Profile'

    $invoke = Invoke-ProductionInstaller 'no-token-rerun' $null $false `
        ([string]$script:Manifest.images.candidate.repository) $false
    if ($invoke.resultCode -ne 0) { Fail-Gate 'NO_TOKEN_RERUN_FAILED' }
    $state = Get-StableState 'none'
    if ($state.imageId -cne $script:CandidateImageId) { Fail-Gate 'CANDIDATE_CONTAINER_IMAGE_MISMATCH' }
    Assert-ExpectedProfile $state.profile $null
    Invoke-RuntimeSecretScan 'no-token-rerun'
    Add-Scenario $invoke $state 'healthy ordinary rerun; no Profile'

    # 2. Failures before a valid Profile must preserve container + write-set.
    $before = $state
    $invoke = Invoke-ProductionInstaller 'malformed-token' 'not-a-bootstrap-token' $true `
        ([string]$script:Manifest.images.candidate.repository) $false
    if ($invoke.resultCode -eq 0 -or $invoke.category -cne 'invalid-arguments') {
        Fail-Gate 'MALFORMED_TOKEN_DID_NOT_FAIL_CLOSED'
    }
    $state = Get-StableState 'none'
    Assert-ProtectedStateUnchanged $before $state $true
    Invoke-RuntimeSecretScan 'malformed-token'
    Add-Scenario $invoke $state 'nonzero; zero protected-state mutation'

    $before = $state
    $networkToken = [string]$script:Secrets.tokens.network
    $invoke = Invoke-ProductionInstaller 'network-failure' $networkToken $true `
        ([string]$script:Manifest.images.candidate.repository) $true
    $networkToken = $null
    if ($invoke.resultCode -eq 0 -or -not $invoke.networkFaultObserved) {
        Fail-Gate 'NETWORK_FAULT_DID_NOT_FAIL_CLOSED'
    }
    $state = Get-StableState 'none'
    Assert-ProtectedStateUnchanged $before $state $true
    Invoke-RuntimeSecretScan 'network-failure'
    Add-Scenario $invoke $state 'nonzero; loopback proxy fault; zero protected-state mutation'

    $before = $state
    $unknownToken = [string]$script:Secrets.tokens.unknown
    $unknown = Invoke-ProductionInstaller 'unknown-token' $unknownToken $true `
        ([string]$script:Manifest.images.candidate.repository) $false
    $unknownToken = $null
    if ($unknown.resultCode -eq 0 -or $unknown.category -cne 'redemption-http-401') {
        Fail-Gate 'UNKNOWN_TOKEN_DID_NOT_RETURN_GENERIC_401'
    }
    $state = Get-StableState 'none'
    Assert-ProtectedStateUnchanged $before $state $true
    Invoke-RuntimeSecretScan 'unknown-token'
    Add-Scenario $unknown $state 'generic 401; zero protected-state mutation'

    $before = $state
    $revokedToken = [string]$script:Secrets.tokens.revoked
    $revoked = Invoke-ProductionInstaller 'revoked-token' $revokedToken $true `
        ([string]$script:Manifest.images.candidate.repository) $false
    $revokedToken = $null
    if ($revoked.resultCode -eq 0 -or $revoked.category -cne 'redemption-http-401' -or
        $revoked.category -cne $unknown.category -or
        $revoked.outputSha256 -cne $unknown.outputSha256) {
        Fail-Gate 'REVOKED_TOKEN_DID_NOT_RETURN_GENERIC_401'
    }
    $state = Get-StableState 'none'
    Assert-ProtectedStateUnchanged $before $state $true
    Invoke-RuntimeSecretScan 'revoked-token'
    Add-Scenario $revoked $state 'same generic 401 shape; zero protected-state mutation'

    $before = $state
    $badToken = [string]$script:Secrets.tokens.badCapsule
    Add-CapsuleRedemptionAttestation 'bad-capsule-before-installer' $badToken $null `
        ([string]$script:Manifest.expectedFailures.badCapsule.capsuleDigest) `
        $script:Secrets.modelKeys.badCapsule
    $invoke = Invoke-ProductionInstaller 'bad-capsule' $badToken $true `
        ([string]$script:Manifest.images.candidate.repository) $false
    if ($invoke.resultCode -eq 0 -or $invoke.category -cne 'capsule-stage-rejected') {
        Fail-Gate 'BAD_CAPSULE_DID_NOT_FAIL_AT_STAGE'
    }
    Add-CapsuleRedemptionAttestation 'bad-capsule-after-installer' $badToken $null `
        ([string]$script:Manifest.expectedFailures.badCapsule.capsuleDigest) `
        $script:Secrets.modelKeys.badCapsule
    $badToken = $null
    $state = Get-StableState 'none'
    Assert-ProtectedStateUnchanged $before $state $false
    Invoke-RuntimeSecretScan 'bad-capsule'
    Add-Scenario $invoke $state 'nonzero at stage; write-set unchanged; no transaction markers'

    # 3. Valid, same-token no-op, rotate, and health rollback.
    $validToken = [string]$script:Secrets.tokens.valid
    Add-CapsuleRedemptionAttestation 'valid-profile' $validToken `
        $script:Manifest.expectedProfiles.valid `
        ([string]$script:Manifest.expectedProfiles.valid.digest) `
        $script:Secrets.modelKeys.valid
    $invoke = Invoke-ProductionInstaller 'valid-profile' $validToken $true `
        ([string]$script:Manifest.images.candidate.repository) $false
    $validToken = $null
    if ($invoke.resultCode -ne 0) { Fail-Gate 'VALID_PROFILE_FAILED' }
    $state = Get-StableState 'valid'
    if ($state.imageId -cne $script:CandidateImageId) { Fail-Gate 'CANDIDATE_CONTAINER_IMAGE_MISMATCH' }
    Assert-ExpectedProfile $state.profile $script:Manifest.expectedProfiles.valid
    Invoke-RuntimeSecretScan 'valid-profile'
    Add-Scenario $invoke $state 'healthy; expected Profile committed'

    $before = $state
    $sameToken = [string]$script:Secrets.tokens.valid
    $invoke = Invoke-ProductionInstaller 'same-token-rerun' $sameToken $true `
        ([string]$script:Manifest.images.candidate.repository) $false
    $sameToken = $null
    if ($invoke.resultCode -ne 0) { Fail-Gate 'SAME_TOKEN_RERUN_FAILED' }
    $state = Get-StableState 'valid'
    Assert-ExpectedProfile $state.profile $script:Manifest.expectedProfiles.valid
    if ([string]$before.volume.declaredWriteSetSha256 -cne
            [string]$state.volume.declaredWriteSetSha256 -or
        [string]$before.volume.declaredWriteSetObservationSha256 -cne
            [string]$state.volume.declaredWriteSetObservationSha256) {
        Fail-Gate 'SAME_TOKEN_WRITE_SET_DRIFT'
    }
    Invoke-RuntimeSecretScan 'same-token-rerun'
    Add-Scenario $invoke $state 'healthy; Profile bytes and metadata no-op'

    $rotateToken = [string]$script:Secrets.tokens.rotate
    Add-CapsuleRedemptionAttestation 'rotate-profile' $rotateToken `
        $script:Manifest.expectedProfiles.rotate `
        ([string]$script:Manifest.expectedProfiles.rotate.digest) `
        $script:Secrets.modelKeys.rotate
    $invoke = Invoke-ProductionInstaller 'rotate-profile' $rotateToken $true `
        ([string]$script:Manifest.images.candidate.repository) $false
    $rotateToken = $null
    if ($invoke.resultCode -ne 0) { Fail-Gate 'ROTATE_PROFILE_FAILED' }
    $state = Get-StableState 'rotate'
    Assert-ExpectedProfile $state.profile $script:Manifest.expectedProfiles.rotate
    Invoke-RuntimeSecretScan 'rotate-profile'
    Add-Scenario $invoke $state 'healthy; higher revision committed'

    $before = $state
    $oldContainerId = [string]$before.containerId
    Assert-ImageReferenceId $script:HealthFailRef $script:HealthFailImageId | Out-Null
    $healthToken = [string]$script:Secrets.tokens.healthFail
    Add-CapsuleRedemptionAttestation 'health-fail-rollback' $healthToken `
        $script:Manifest.expectedProfiles.healthFail `
        ([string]$script:Manifest.expectedProfiles.healthFail.digest) `
        $script:Secrets.modelKeys.healthFail
    $invoke = Invoke-ProductionInstaller 'health-fail-rollback' $healthToken $true `
        ([string]$script:Manifest.images.healthFail.repository) $false
    if ($invoke.resultCode -eq 0 -or $invoke.category -cne 'replacement-health-timeout') {
        Fail-Gate 'HEALTH_FAIL_IMAGE_DID_NOT_FAIL_AS_EXPECTED'
    }
    Assert-ImageReferenceId $script:HealthFailRef $script:HealthFailImageId | Out-Null
    Add-CapsuleRedemptionAttestation 'health-fail-after-installer' $healthToken `
        $script:Manifest.expectedProfiles.healthFail `
        ([string]$script:Manifest.expectedProfiles.healthFail.digest) `
        $script:Secrets.modelKeys.healthFail
    $healthToken = $null
    $state = Get-StableState 'rotate'
    if ($state.containerId -cne $oldContainerId -or $state.imageId -cne $script:CandidateImageId) {
        Fail-Gate 'OLD_CONTAINER_ID_NOT_RESTORED'
    }
    Assert-ExpectedProfile $state.profile $script:Manifest.expectedProfiles.rotate
    if ([string]$before.volume.declaredWriteSetSha256 -cne
            [string]$state.volume.declaredWriteSetSha256 -or
        [int]$state.volume.activeTransactionMarkerCount -ne 0) {
        Fail-Gate 'HEALTH_FAIL_VOLUME_ROLLBACK_MISMATCH'
    }
    Invoke-RuntimeSecretScan 'health-fail-rollback'
    Add-Scenario $invoke $state `
        'nonzero; health image ref stable; exact old container ID and four-volume write-set restored'
}

function Test-ContainerOwnedForCleanup([string]$Name) {
    $result = Invoke-Docker @('container', 'inspect', $Name) -AllowFailure -SkipSecretScan
    if ($result.exitCode -ne 0) { return $false }
    try { $container = @($result.text | ConvertFrom-Json -ErrorAction Stop)[0] } catch {
        Fail-Gate 'CLEANUP_CONTAINER_INSPECT_FAILED'
    }
    if (@($script:CandidateCleanupImageId, $script:HealthFailCleanupImageId) -notcontains
        [string]$container.Image) {
        Fail-Gate 'REFUSING_UNKNOWN_CONTAINER_CLEANUP'
    }
    $created = [DateTimeOffset]::Parse([string]$container.Created,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal)
    if ($created -lt $script:StartedAt.AddMinutes(-1)) {
        Fail-Gate 'REFUSING_PREEXISTING_CONTAINER_CLEANUP'
    }
    $mounts = @($container.Mounts | Where-Object { $_.Type -eq 'volume' } |
        ForEach-Object { [string]$_.Name } | Sort-Object)
    if (($mounts -join "`n") -cne (@($script:VolumeNames | Sort-Object) -join "`n")) {
        Fail-Gate 'REFUSING_WRONG_TOPOLOGY_CONTAINER_CLEANUP'
    }
    $bindings = @($container.HostConfig.PortBindings.'28789/tcp')
    if ($bindings.Count -ne 1 -or [string]$bindings[0].HostIp -cne '127.0.0.1' -or
        [string]$bindings[0].HostPort -cne '28789') {
        Fail-Gate 'REFUSING_WRONG_PORT_CONTAINER_CLEANUP'
    }
    return $true
}

function Remove-GateResources {
    $removed = New-Object System.Collections.ArrayList
    $probe = Invoke-Docker @('container', 'inspect', $script:ProbeContainer) `
        -AllowFailure -SkipSecretScan
    if ($probe.exitCode -eq 0) {
        try { $probeValue = @($probe.text | ConvertFrom-Json -ErrorAction Stop)[0] } catch {
            Fail-Gate 'CLEANUP_PROBE_INSPECT_FAILED'
        }
        if ([string]$probeValue.Config.Labels.'ai.wentor.acceptance.run-id' -cne $script:RunId) {
            Fail-Gate 'REFUSING_UNKNOWN_PROBE_CLEANUP'
        }
        Invoke-Docker @('container', 'rm', '--force', $script:ProbeContainer) | Out-Null
        [void]$removed.Add('probe-container')
    }
    foreach ($name in @($script:Container, $script:RollbackContainer)) {
        if (Test-ContainerOwnedForCleanup $name) {
            Invoke-Docker @('container', 'rm', '--force', $name) | Out-Null
            [void]$removed.Add(('container:' + $name))
        }
    }
    foreach ($name in $script:VolumeNames) {
        $exists = Invoke-Docker @('volume', 'inspect', $name) -AllowFailure
        if ($exists.exitCode -eq 0) {
            Assert-OwnedVolume $name
            Invoke-Docker @('volume', 'rm', $name) | Out-Null
            [void]$removed.Add(('volume:' + $name))
        }
    }
    $imagePairs = @(
        [pscustomobject]@{
            references = @($script:CandidateRef, $script:CandidateDigestRef)
            imageId = $script:CandidateCleanupImageId
        },
        [pscustomobject]@{
            references = @($script:HealthFailRef, $script:HealthFailDigestRef)
            imageId = $script:HealthFailCleanupImageId
        }
    )
    foreach ($pair in $imagePairs) {
        foreach ($reference in @($pair.references)) {
            if (-not $reference) { continue }
            $exists = Invoke-Docker @('image', 'inspect', [string]$reference) -AllowFailure
            if ($exists.exitCode -eq 0) {
                try { $image = @($exists.text | ConvertFrom-Json -ErrorAction Stop)[0] } catch {
                    Fail-Gate 'CLEANUP_IMAGE_INSPECT_FAILED'
                }
                if (-not $pair.imageId -or [string]$image.Id -cne [string]$pair.imageId) {
                    Fail-Gate 'REFUSING_CHANGED_IMAGE_REF_CLEANUP'
                }
                Invoke-Docker @('image', 'rm', [string]$reference) | Out-Null
                [void]$removed.Add(('image-ref:' + [string]$reference))
            }
        }
        foreach ($reference in @($pair.references)) {
            if (-not $reference) { continue }
            $remaining = Invoke-Docker @('image', 'inspect', [string]$reference) `
                -AllowFailure -SkipSecretScan
            if ($remaining.exitCode -eq 0) {
                Fail-Gate 'GATE_IMAGE_REFERENCE_CLEANUP_INCOMPLETE'
            }
        }
    }
    $remainingContainers = @(Invoke-Docker @('container', 'ls', '--all', '--format', '{{.Names}}')).text -split "`n"
    $remainingVolumes = @(Invoke-Docker @('volume', 'ls', '--format', '{{.Name}}')).text -split "`n"
    if (@($remainingContainers | Where-Object {
            @($script:Container, $script:RollbackContainer, $script:ProbeContainer) -contains $_
        }).Count -ne 0 -or
        @($remainingVolumes | Where-Object { $script:VolumeNames -contains $_ }).Count -ne 0) {
        Fail-Gate 'GATE_RESOURCE_CLEANUP_INCOMPLETE'
    }
    if (Get-NewTempArtifacts) { Fail-Gate 'HOST_TEMP_CLEANUP_INCOMPLETE' }
    return @($removed)
}

function Write-PrivateUtf8FileExclusive([string]$Path, [string]$Text) {
    $bytes = $script:Utf8NoBom.GetBytes($Text)
    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        if ($stream.Position -ne $bytes.Length -or $stream.Length -ne $bytes.Length) {
            Fail-Gate 'EVIDENCE_WRITE_FAILED'
        }
    } finally {
        if ($stream) { $stream.Dispose() }
        if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Write-Evidence($Evidence) {
    $version = $PSVersionTable.PSVersion.ToString()
    $edition = if ($PSVersionTable.PSObject.Properties.Name -contains 'PSEdition') {
        [string]$PSVersionTable.PSEdition
    } else { 'Desktop' }
    $fileName = 'windows-bootstrap-docker-ps{0}-{1}.json' -f
        $version.Replace('.', '_'), $script:RunId
    $target = Join-Path $script:EvidenceResolved $fileName
    $json = ($Evidence | ConvertTo-Json -Depth 100 -Compress) + "`n"
    Assert-NoSecretText $json 'EVIDENCE_SECRET_LEAK'
    $shaTarget = $target + '.sha256'
    if ((Test-Path -LiteralPath $target) -or
        (Test-Path -LiteralPath $shaTarget)) {
        Fail-Gate 'EVIDENCE_OUTPUT_ALREADY_EXISTS'
    }
    $jsonTemporary = Join-Path $script:EvidenceResolved (
        '.evidence-json-' + $script:RunId + '.tmp'
    )
    $shaTemporary = Join-Path $script:EvidenceResolved (
        '.evidence-sha-' + $script:RunId + '.tmp'
    )
    Write-PrivateUtf8FileExclusive $jsonTemporary $json
        $jsonSnapshot = Read-StrictUtf8Snapshot $jsonTemporary 16777216 `
            'EVIDENCE_WRITE_FAILED'
        try {
            if ($jsonSnapshot.text -cne $json) { Fail-Gate 'EVIDENCE_WRITE_FAILED' }
            $sha = [string]$jsonSnapshot.sha256
        } finally {
            if ($jsonSnapshot.bytes) {
                [Array]::Clear($jsonSnapshot.bytes, 0, $jsonSnapshot.bytes.Length)
            }
            $jsonSnapshot.text = $null
        }
        $checksumText = ('{0} *{1}' -f $sha, $fileName) + "`n"
        Write-PrivateUtf8FileExclusive $shaTemporary $checksumText
        $shaSnapshot = Read-StrictUtf8Snapshot $shaTemporary 4096 `
            'EVIDENCE_WRITE_FAILED'
        try {
            if ($shaSnapshot.text -cne $checksumText) {
                Fail-Gate 'EVIDENCE_WRITE_FAILED'
            }
        } finally {
            if ($shaSnapshot.bytes) {
                [Array]::Clear($shaSnapshot.bytes, 0, $shaSnapshot.bytes.Length)
            }
            $shaSnapshot.text = $null
        }
        # Publish the checksum first. A passed JSON final name is therefore
        # never visible without its already-complete checksum companion.
        [System.IO.File]::Move($shaTemporary, $shaTarget)
        [System.IO.File]::Move($jsonTemporary, $target)
    return [ordered]@{
        json = $target
        sha256 = $sha
        checksumFile = $shaTarget
        edition = $edition
    }
}

$fatal = $null
$cleanupError = $null
$cleanupRemoved = @()
$imageEvidence = $null
$evidenceOutput = $null
try {
    Read-AndValidateInputs
    Assert-HostAndDockerPreflight
    New-PrivateEvidenceDirectory $script:EvidenceResolved
    New-VolumeHelperSnapshot

    $script:GateMutated = $true
    $candidateEvidence = Assert-ImageProvenance $script:Manifest.images.candidate `
        $script:CandidateRef $false
    $script:CandidateImageId = [string]$candidateEvidence.observedImageId
    $healthEvidence = Assert-ImageProvenance $script:Manifest.images.healthFail `
        $script:HealthFailRef $true
    $script:HealthFailImageId = [string]$healthEvidence.observedImageId
    Assert-HealthFailImageParity
    $imageEvidence = [ordered]@{
        candidate = $candidateEvidence
        healthFail = $healthEvidence
        parity = $script:ImageParityEvidence
    }
    New-OwnedVolumes
    foreach ($name in $script:VolumeNames) { Assert-OwnedVolume $name }
    Seed-UserOwnedVolumeMarkers
    Run-AcceptanceScenarios
} catch {
    $fatal = Get-SafeFailureCode ([string]$_.Exception.Message) 'UNCLASSIFIED_GATE_FAILURE'
} finally {
    try { Restore-ProxyState } catch {}
    $env:MIRROR = $script:OriginalMirror
    $tempCleanupError = $null
    try {
        if ($script:SecretNeedles.Count -gt 0) {
            Scan-AndRemoveTempArtifacts 'final-cleanup' | Out-Null
        }
    } catch {
        $tempCleanupError = Get-SafeFailureCode ([string]$_.Exception.Message) `
            'UNCLASSIFIED_TEMP_CLEANUP_FAILURE'
    }
    try {
        if ($script:GateMutated) { $cleanupRemoved = Remove-GateResources }
    } catch {
        $cleanupError = Get-SafeFailureCode ([string]$_.Exception.Message) `
            'UNCLASSIFIED_RESOURCE_CLEANUP_FAILURE'
    }
    if ($null -ne $tempCleanupError -and $null -eq $cleanupError) {
        $cleanupError = $tempCleanupError
    }
    try {
        Remove-VolumeHelperSnapshot
    } catch {
        if ($null -eq $cleanupError) {
            $cleanupError = Get-SafeFailureCode ([string]$_.Exception.Message) `
                'UNCLASSIFIED_HELPER_SNAPSHOT_CLEANUP_FAILURE'
        }
    }
    try {
        Assert-InputSourcesStable
    } catch {
        if ($null -eq $cleanupError) {
            $cleanupError = Get-SafeFailureCode ([string]$_.Exception.Message) `
                'UNCLASSIFIED_INPUT_STABILITY_FAILURE'
        }
    }
    if ($null -eq $fatal -and (
        $script:ScenarioResults.Count -ne 11 -or
        $script:RuntimeScans.Count -ne 11 -or
        $script:CapsuleAttestations.Count -ne 6 -or
        $null -eq $script:InstallerSecretFlowContract -or
        $script:InstallerSecretFlowContract.passed -ne $true)) {
        $fatal = 'INCOMPLETE_ACCEPTANCE_EVIDENCE'
    }

    if ($script:EvidenceCreated) {
        $hostEvidence = [ordered]@{
            computerNameSha256 = Get-StringSha256 ([string]$env:COMPUTERNAME)
            osVersion = [System.Environment]::OSVersion.VersionString
            osArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
            nativePlatform = $script:WindowsPlatformEvidence
            process64Bit = [Environment]::Is64BitProcess
            powerShellVersion = $PSVersionTable.PSVersion.ToString()
            powerShellEdition = if ($PSVersionTable.PSObject.Properties.Name -contains 'PSEdition') {
                [string]$PSVersionTable.PSEdition
            } else { 'Desktop' }
        }
        $evidence = [ordered]@{
            schemaVersion = 1
            gate = 'research-claw-0.8.3-windows-x64-docker-desktop'
            runId = $script:RunId
            status = if ($null -eq $fatal -and $null -eq $cleanupError -and
                $script:ScenarioResults.Count -eq 11 -and
                $script:RuntimeScans.Count -eq 11 -and
                $script:CapsuleAttestations.Count -eq 6 -and
                $null -ne $script:InstallerSecretFlowContract -and
                $script:InstallerSecretFlowContract.passed -eq $true) { 'passed' } else { 'failed' }
            startedAtUtc = $script:StartedAt.ToString('o')
            completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
            manifest = [ordered]@{
                pathSha256 = Get-StringSha256 $script:ManifestResolved
                bytesSha256 = $script:ManifestInputSha256
                parsedFromSingleSnapshot = $true
                sourceStableAtEnd = $script:InputSourcesStableAtEnd
                gateId = if ($script:Manifest) { [string]$script:Manifest.gateId } else { $null }
                fixtureAuthorityId = if ($script:Manifest) {
                    [string]$script:Manifest.fixtureAuthority.id
                } else { $null }
            }
            acceptanceHarness = [ordered]@{
                pathSha256 = Get-StringSha256 $script:AcceptanceHarnessResolved
                sha256 = $script:AcceptanceHarnessStartSha256
                startAndEndStable = $script:InputSourcesStableAtEnd
            }
            installer = [ordered]@{
                pathSha256 = Get-StringSha256 $script:InstallerResolved
                sha256 = $script:InstallerSnapshotSha256
                invokedInProcess = $true
                sourceMode = 'sha256-pinned-exact-utf8-dynamic-scriptblock'
                parsedAndInvokedFromSingleSnapshot = $true
                sourceStableAtEnd = $script:InputSourcesStableAtEnd
                secretFlowContract = $script:InstallerSecretFlowContract
                runtimeObservationBoundary = `
                    'posthoc-surviving-containers-current-host-processes-and-host-temp'
            }
            evidenceHelper = [ordered]@{
                pathSha256 = Get-StringSha256 $script:VolumeHelperSourceResolved
                sha256 = $script:VolumeHelperSourceSha256
                mountedReadOnly = $true
                includedInReleaseImage = $false
                executedFromPrivateSnapshot = $true
                snapshotRemoved = $script:VolumeHelperSnapshotRemoved
                sourceStableAtEnd = $script:InputSourcesStableAtEnd
            }
            host = $hostEvidence
            docker = $script:DockerEvidence
            images = $imageEvidence
            capsuleAttestations = @($script:CapsuleAttestations)
            userOwnedVolumeMarkers = $script:UserMarkerBaseline
            volumeSecretScan = [ordered]@{
                source = 'docker-cp-to-acl-private-host-export'
                scanner = 'in-process-dotnet-aho-corasick'
                secretBundleMountedIntoContainer = $false
                exportDeletedAfterEveryObservation = $true
            }
            scenarios = @($script:ScenarioResults)
            secretScans = @($script:RuntimeScans)
            cleanup = [ordered]@{
                removed = $cleanupRemoved
                evidencePreserved = $true
                errorCode = $cleanupError
            }
            failureCode = $fatal
        }
        try {
            $evidenceOutput = Write-Evidence $evidence
        } catch {
            if ($null -eq $fatal) { $fatal = 'EVIDENCE_WRITE_FAILED' }
        }
    }
    $script:Secrets = $null
    $script:SecretNeedles = @()
    $script:InstallerScriptBlock = $null
    $script:InstallerSecretFlowContract = $null
    $script:ManifestInputText = $null
    $script:SecretBundleInputSha256 = $null
    if ($script:VolumeHelperSnapshotBytes) {
        [Array]::Clear(
            $script:VolumeHelperSnapshotBytes,
            0,
            $script:VolumeHelperSnapshotBytes.Length
        )
        $script:VolumeHelperSnapshotBytes = $null
    }
    [GC]::Collect()
}

if ($null -ne $fatal -or $null -ne $cleanupError) {
    $evidenceHint = if ($evidenceOutput) { [string]$evidenceOutput.json } else { 'not-written' }
    throw "Windows Bootstrap gate failed; evidence: $evidenceHint"
}

Write-Host ('Windows Bootstrap gate passed. Evidence: {0}' -f $evidenceOutput.json)
Write-Host ('SHA-256: {0}' -f $evidenceOutput.sha256)
