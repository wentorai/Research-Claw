param()

if ($args.Count -ne 0) {
    throw 'Unknown Docker acceptance argument.'
}

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ExpectedVersion = '0.8.3'
$ExpectedRevision = 'b9bd4c2c546cddd9a53871165094394d42da1543'
$IndexDigest = 'sha256:fb5fe72c215c11f744ef8aa00151d1169219fee479d2e528f934c322a7806dd2'
$Amd64ManifestDigest = 'sha256:6b2a1ba0268b39858670677189755e5582f96c3bcad3b88ae4d372964d823a88'
$AcrRepository = 'crpi-i37tqr5mfyhrq1z0.cn-hangzhou.personal.cr.aliyuncs.com/wentorai/research-claw'
$GhcrRepository = 'ghcr.io/wentorai/research-claw'

$editionLabel = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'Desktop5' } else { 'Core7' }
$runId = "{0}-{1}" -f (Get-Date -Format 'yyyyMMddHHmmssfff'), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$owner = "wentor-docker-{0}" -f ([Guid]::NewGuid().ToString('N').Substring(0, 12))
$containerName = "$owner-gateway"
$helperName = "$owner-helper"
$volumeNames = @(
    "$owner-config",
    "$owner-data",
    "$owner-workspace",
    "$owner-state"
)
$volumeDestinations = @(
    '/app/config',
    '/app/.research-claw',
    '/app/workspace',
    '/root/.openclaw'
)
$reportRoot = Join-Path $env:LOCALAPPDATA 'Wentor\ProbeReports'
$reportBase = "Wentor-Docker-Test-$editionLabel-$runId"
$started = Get-Date
$steps = New-Object System.Collections.Generic.List[object]
$status = 'FAILED'
$failure = $null
$docker = $null
$imageReference = $null
$imageId = $null
$containerId = $null
$createdVolumes = New-Object System.Collections.Generic.List[string]
$cleanupOk = $true

function Add-Step([string]$Name, [string]$State, [string]$Detail) {
    $steps.Add([ordered]@{
            name = $Name
            status = $State
            detail = $Detail
        })
    $color = if ($State -eq 'PASS') { 'Green' } elseif ($State -eq 'WARN') { 'Yellow' } else { 'Red' }
    Write-Host ("[{0}] {1}: {2}" -f $State, $Name, $Detail) -ForegroundColor $color
}

function Invoke-Docker([string[]]$DockerArguments, [switch]$AllowFailure) {
    if (-not $docker) { throw 'docker.exe is unavailable.' }
    $output = @(& $docker.Source @DockerArguments 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        $tail = @($output | Select-Object -Last 4) -join ' | '
        throw "docker command failed with exit code ${exitCode}: $tail"
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = $output
        Text = ($output -join "`n")
    }
}

function Test-ResourceExists([string]$Kind, [string]$Name) {
    $result = Invoke-Docker @($Kind, 'inspect', $Name) -AllowFailure
    return $result.ExitCode -eq 0
}

function Remove-OwnedResources {
    $script:cleanupOk = $true
    foreach ($name in @($containerName, $helperName)) {
        if (-not (Test-ResourceExists 'container' $name)) { continue }
        $label = (Invoke-Docker @(
                'container', 'inspect', '--format',
                '{{index .Config.Labels "wentor.acceptance.owner"}}', $name
            )).Text.Trim()
        if ($label -ne $owner) {
            Add-Step 'cleanup.task-owned-resources' 'FAIL' "refused foreign container $name"
            $script:cleanupOk = $false
            continue
        }
        $removed = Invoke-Docker @('container', 'rm', '--force', $name) -AllowFailure
        if ($removed.ExitCode -ne 0 -or (Test-ResourceExists 'container' $name)) {
            Add-Step 'cleanup.task-owned-resources' 'FAIL' "container cleanup failed for $name"
            $script:cleanupOk = $false
        }
    }
    foreach ($name in @($createdVolumes)) {
        if (-not (Test-ResourceExists 'volume' $name)) { continue }
        $label = (Invoke-Docker @(
                'volume', 'inspect', '--format',
                '{{index .Labels "wentor.acceptance.owner"}}', $name
            )).Text.Trim()
        if ($label -ne $owner) {
            Add-Step 'cleanup.task-owned-resources' 'FAIL' "refused foreign volume $name"
            $script:cleanupOk = $false
            continue
        }
        $removed = Invoke-Docker @('volume', 'rm', $name) -AllowFailure
        if ($removed.ExitCode -ne 0 -or (Test-ResourceExists 'volume' $name)) {
            Add-Step 'cleanup.task-owned-resources' 'FAIL' "volume cleanup failed for $name"
            $script:cleanupOk = $false
        }
    }
    if ($script:cleanupOk) {
        Add-Step 'cleanup.task-owned-resources' 'PASS' 'all labelled containers and volumes are absent'
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
        image = [ordered]@{
            repository = if ($imageReference) { $imageReference.Split('@')[0] } else { $null }
            indexDigest = $IndexDigest
            amd64ManifestDigest = $Amd64ManifestDigest
            observedImageId = $imageId
            expectedVersion = $ExpectedVersion
            expectedRevision = $ExpectedRevision
        }
        startedUtc = $started.ToUniversalTime().ToString('o')
        finishedUtc = $finished.ToUniversalTime().ToString('o')
        elapsedSeconds = [Math]::Round(($finished - $started).TotalSeconds, 3)
        cleanupPassed = $cleanupOk
        steps = @($steps)
    }
    $json = $payload | ConvertTo-Json -Depth 8
    $utf8 = New-Object Text.UTF8Encoding($false)
    $jsonPath = Join-Path $reportRoot "$reportBase.json"
    $txtPath = Join-Path $reportRoot "$reportBase.txt"
    [IO.File]::WriteAllText($jsonPath, "$json`r`n", $utf8)
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('Wentor Windows Docker Desktop host smoke')
    $lines.Add("status=$status")
    $lines.Add("powershell=$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)")
    $lines.Add("indexDigest=$IndexDigest")
    $lines.Add("amd64ManifestDigest=$Amd64ManifestDigest")
    foreach ($step in $steps) {
        $lines.Add("[$($step.status)] $($step.name): $($step.detail)")
    }
    if ($failure) { $lines.Add("failure=$failure") }
    [IO.File]::WriteAllText($txtPath, (($lines -join "`r`n") + "`r`n"), $utf8)
    Write-Host "WENTOR_DOCKER_REPORT=$txtPath"
    Write-Host "WENTOR_DOCKER_JSON=$jsonPath"
}

Write-Host ''
Write-Host 'Wentor Windows Docker Desktop host smoke' -ForegroundColor Cyan
Write-Host 'This uses one exact public 0.8.3 image and unique task-owned resources.'
Write-Host 'It does not read a Setup Token or model API key and requires no keyboard input.'
Write-Host ''

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This runner requires native Windows.'
    }
    $validShell = ($PSVersionTable.PSEdition -eq 'Desktop' -and $PSVersionTable.PSVersion.Major -eq 5) `
        -or ($PSVersionTable.PSEdition -eq 'Core' -and $PSVersionTable.PSVersion.Major -ge 7)
    $administrator = New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent()
    )
    if (-not $validShell -or -not [Environment]::Is64BitOperatingSystem `
        -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' `
        -or -not $administrator.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Native Windows x64, PowerShell 5.1/7 and Administrator rights are required.'
    }
    Add-Step 'host.windows-x64-admin' 'PASS' 'native x64 administrator shell accepted'

    $docker = Get-Command docker.exe -ErrorAction SilentlyContinue
    if (-not $docker) { throw 'docker.exe was not found. Install and start Docker Desktop first.' }
    $server = (Invoke-Docker @('version', '--format', '{{.Server.Os}}|{{.Server.Arch}}|{{.Server.Version}}')).Text.Trim()
    $serverParts = @($server -split '\|')
    if ($serverParts.Count -ne 3 -or $serverParts[0] -ne 'linux' `
        -or $serverParts[1] -notin @('amd64', 'x86_64')) {
        throw "Docker server is not Linux/amd64: $server"
    }
    Add-Step 'docker.linux-amd64' 'PASS' "server=$server"

    foreach ($name in @($containerName, $helperName)) {
        if (Test-ResourceExists 'container' $name) { throw "Refusing existing container $name" }
    }
    foreach ($name in $volumeNames) {
        if (Test-ResourceExists 'volume' $name) { throw "Refusing existing volume $name" }
    }

    $repositories = @($AcrRepository, $GhcrRepository)
    foreach ($repository in $repositories) {
        $candidate = "$repository@$IndexDigest"
        Write-Host "[..] Pulling exact linux/amd64 image from $repository"
        $pull = Invoke-Docker @('pull', '--platform', 'linux/amd64', $candidate) -AllowFailure
        if ($pull.ExitCode -eq 0) {
            $imageReference = $candidate
            break
        }
    }
    if (-not $imageReference) { throw 'Neither ACR nor GHCR exact image pull succeeded.' }

    $imageInspectText = (Invoke-Docker @('image', 'inspect', $imageReference)).Text
    $imageInspect = @($imageInspectText | ConvertFrom-Json)[0]
    $imageId = [string]$imageInspect.Id
    if ($imageInspect.Os -ne 'linux' -or $imageInspect.Architecture -ne 'amd64' `
        -or $imageInspect.Config.Labels.'org.opencontainers.image.version' -ne $ExpectedVersion `
        -or $imageInspect.Config.Labels.'org.opencontainers.image.revision' -ne $ExpectedRevision `
        -or $imageInspect.Config.Env -notcontains "RC_BUILD_VERSION=$ExpectedVersion" `
        -or $imageInspect.Config.Env -notcontains "RC_BUILD_COMMIT=$ExpectedRevision") {
        throw 'Pulled image platform, labels or runtime environment did not match.'
    }
    Add-Step 'image.remote-digest-binding' 'PASS' 'exact index digest resolved to expected linux/amd64 config'

    for ($index = 0; $index -lt $volumeNames.Count; $index++) {
        $name = $volumeNames[$index]
        Invoke-Docker @('volume', 'create', '--label', "wentor.acceptance.owner=$owner", $name) | Out-Null
        $createdVolumes.Add($name)
    }

    $runArguments = @(
        'run', '-d', '--platform', 'linux/amd64', '--name', $containerName,
        '--label', "wentor.acceptance.owner=$owner"
    )
    for ($index = 0; $index -lt $volumeNames.Count; $index++) {
        $runArguments += @('-v', "$($volumeNames[$index]):$($volumeDestinations[$index])")
    }
    $runArguments += $imageReference
    $containerId = (Invoke-Docker $runArguments).Text.Trim()
    if ($containerId -notmatch '^[0-9a-f]{64}$') { throw 'Docker returned an invalid container ID.' }

    $deadline = (Get-Date).AddMinutes(4)
    $lastHealth = 'unknown'
    while ((Get-Date) -lt $deadline) {
        $lastHealth = (Invoke-Docker @(
                'container', 'inspect', '--format',
                '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', $containerId
            )).Text.Trim()
        if ($lastHealth -eq 'healthy') { break }
        if ($lastHealth -eq 'unhealthy') { throw 'Container healthcheck became unhealthy.' }
        Write-Host "[..] Waiting for container health: $lastHealth"
        Start-Sleep -Seconds 5
    }
    if ($lastHealth -ne 'healthy') { throw "Container did not become healthy: $lastHealth" }

    $healthScript = @'
const http = require('http');
const request = http.get({host:'127.0.0.1',port:28789,path:'/healthz'}, (response) => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => body += chunk);
  response.on('end', () => {
    const value = JSON.parse(body);
    if (response.statusCode !== 200 || value.ok !== true || value.status !== 'live') process.exit(3);
    process.stdout.write('HEALTH_OK');
  });
});
request.setTimeout(10000, () => request.destroy(new Error('timeout')));
request.on('error', () => process.exit(4));
'@
    $health = Invoke-Docker @('exec', $containerId, 'node', '-e', $healthScript)
    if ($health.Text.Trim() -ne 'HEALTH_OK') { throw 'Real /healthz response did not match.' }
    Add-Step 'container.healthz' 'PASS' '127.0.0.1:28789 returned HTTP 200 live health inside container'

    $containerInspect = @(((Invoke-Docker @('container', 'inspect', $containerId)).Text | ConvertFrom-Json))[0]
    if ($containerInspect.Image -ne $imageId) { throw 'Container image ID did not match the exact pull.' }
    $observedMounts = @($containerInspect.Mounts | ForEach-Object { "$($_.Name)=$($_.Destination)" } | Sort-Object)
    $expectedMounts = @(
        "$($volumeNames[0])=/app/config",
        "$($volumeNames[1])=/app/.research-claw",
        "$($volumeNames[2])=/app/workspace",
        "$($volumeNames[3])=/root/.openclaw"
    ) | Sort-Object
    if (($observedMounts -join "`n") -ne ($expectedMounts -join "`n")) {
        throw 'Container mount set did not match all four isolated volumes.'
    }
    Add-Step 'volumes.four-mounts' 'PASS' 'four unique named volumes matched exact destinations'

    $sentinelScript = 'umask 077; printf wentor-docker-volume-round-trip > /app/workspace/.wentor-docker-acceptance'
    Invoke-Docker @('exec', $containerId, 'sh', '-c', $sentinelScript) | Out-Null
    $helperScript = 'test "$(cat /workspace/.wentor-docker-acceptance)" = wentor-docker-volume-round-trip && rm -f /workspace/.wentor-docker-acceptance'
    Invoke-Docker @(
        'run', '--rm', '--platform', 'linux/amd64', '--name', $helperName,
        '--label', "wentor.acceptance.owner=$owner",
        '-v', "$($volumeNames[2]):/workspace", '--entrypoint', 'sh',
        $imageReference, '-c', $helperScript
    ) | Out-Null
    Add-Step 'volume.persistence-round-trip' 'PASS' 'second container read and removed the exact workspace sentinel'

    $logs = Invoke-Docker @('container', 'logs', $containerId)
    $top = Invoke-Docker @('container', 'top', $containerId, '-eo', 'pid,ppid,user,etime,args')
    if ($logs.Text -notmatch '\[gateway\] ready' -or $top.Text -notmatch '/entrypoint\.sh') {
        throw 'Container logs or process topology did not match the gateway runtime.'
    }
    $runtimeEvidence = "$($logs.Text)`n$($top.Text)"
    if ($runtimeEvidence -match 'rca_[A-Za-z0-9_-]{43,}' `
        -or $runtimeEvidence -match 'sk-(?:proj-)?[A-Za-z0-9_-]{16,}' `
        -or $runtimeEvidence -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----') {
        throw 'Container logs or process topology contained a secret-shaped value.'
    }
    Add-Step 'container.logs-and-top' 'PASS' 'logs and process topology succeeded with no secret-shaped value'
    $status = 'PASSED'
} catch {
    $failure = $_.Exception.Message
    Add-Step 'acceptance' 'FAIL' $failure
} finally {
    if ($docker) {
        Remove-OwnedResources
        if (-not $cleanupOk) {
            $status = 'FAILED'
            if (-not $failure) { $failure = 'Task-owned Docker cleanup did not complete.' }
        }
    }
    Write-Reports
}

if ($status -ne 'PASSED') { exit 1 }
exit 0
