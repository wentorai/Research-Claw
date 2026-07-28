# ============================================================================
# Research-Claw (科研龙虾) — Docker One-Click Install / Update for Windows
# Hosted at: https://wentor.ai/docker-install.ps1
#
# Usage:
#   irm https://wentor.ai/docker-install.ps1 | iex
#
# Idempotent: safe to re-run for updates (pull -> stage old -> run -> verify).
# Data persists in Docker named volumes across container recreation.
#
# ── Volume Architecture (CRITICAL — do NOT remove any volume) ──────────
# The install script destroys and recreates the container on every run.
# ALL persistent data MUST be on named volumes, or it will be lost.
#
#   rc-config    -> /app/config            API keys, gateway config
#   rc-data      -> /app/.research-claw    RC plugin SQLite DB (library, tasks, monitors)
#   rc-workspace -> /app/workspace         Agent workspace files (MEMORY.md, USER.md)
#   rc-state     -> /root/.openclaw        OC state: sessions (chat history!), logs, plugins
#
# v0.5.2 bug: rc-state was missing -> chat history lost on every update.
# v0.5.3 fix: added rc-state volume. This is the root cause of all
#             "history disappeared after update" reports.
#
# ── Environment Variables ──────────────────────────────────────────────
#   MIRROR   Alternative registry (e.g. registry.cn-hangzhou.aliyuncs.com/wentorai/research-claw)
#            Default: ACR (China), fallback: GHCR
# ============================================================================

& {
# Wrap in scriptblock so $ErrorActionPreference doesn't leak into caller session
$ErrorActionPreference = "Stop"

# -- Mirror / image configuration -------------------------------------------
# Default: Alibaba Cloud ACR (China mainland accessible, no proxy needed).
# Fallback: GHCR (requires proxy in mainland China).
# Override: $env:MIRROR = "your-registry/org/repo"; irm ... | iex
$AcrRepo        = "crpi-i37tqr5mfyhrq1z0.cn-hangzhou.personal.cr.aliyuncs.com/wentorai/research-claw"
$GhcrRepo       = "ghcr.io/wentorai/research-claw"
$ImageRepo      = if ($env:MIRROR) { $env:MIRROR } else { $AcrRepo }
$Image          = "${ImageRepo}:latest"
$Container      = "research-claw"
$RollbackContainer = "${Container}-rollback"
$Port           = 28789
$HealthTimeout  = 60

# -- Banner ----------------------------------------------------------------
Write-Host ""
Write-Host "    ____                              _        ____ _" -ForegroundColor Red
Write-Host "   |  _ \ ___  ___  ___  __ _ _ __ ___| |__    / ___| | __ ___      __" -ForegroundColor Red
Write-Host "   | |_) / _ \/ __|/ _ \/ _`` | '__/ __| '_ \  | |   | |/ _`` \ \ /\ / /" -ForegroundColor Red
Write-Host "   |  _ <  __/\__ \  __/ (_| | | | (__| | | | | |___| | (_| |\ V  V /" -ForegroundColor Red
Write-Host "   |_| \_\___||___/\___|\__,_|_|  \___|_| |_|  \____|_|\__,_| \_/\_/" -ForegroundColor Red
Write-Host ""
Write-Host "  Docker One-Click Install" -ForegroundColor White
Write-Host "  https://wentor.ai" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  5 steps - first install ~3-10 min (mostly image download) - re-run ~30s" -ForegroundColor DarkGray
Write-Host "  Safe to interrupt: re-running resumes where it left off" -ForegroundColor DarkGray

# Diagnostic breadcrumb log: key decisions + failure details, attachable to bug reports
$RcLog = Join-Path $env:TEMP ("rc-docker-install-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
function Write-RcLog([string]$Msg) {
    try { Add-Content -Path $RcLog -Value ("{0} {1}" -f (Get-Date -Format "HH:mm:ss"), $Msg) } catch {}
}
Write-RcLog "docker-install start: $([System.Environment]::OSVersion.VersionString)"
$InstallSw = [System.Diagnostics.Stopwatch]::StartNew()
function Get-ElapsedText {
    "{0}m{1:d2}s" -f [int][math]::Floor($InstallSw.Elapsed.TotalMinutes), $InstallSw.Elapsed.Seconds
}
function Write-Step([int]$N, [string]$Title) {
    Write-Host ""
    Write-Host "  > [$N/5] $Title" -ForegroundColor Cyan
    Write-RcLog "step $N/5: $Title"
}

$script:HadPrevious = $false
function Restore-PreviousContainer {
    if (-not $script:HadPrevious) { return }
    Write-Host "  ! The replacement did not become ready; restoring the previous version." -ForegroundColor Yellow
    & { $ErrorActionPreference = 'Continue'; docker rm -f $Container 2>&1 | Out-Null }
    & { $ErrorActionPreference = 'Continue'; docker rename $RollbackContainer $Container 2>&1 | Out-Null }
    $renamed = $LASTEXITCODE -eq 0
    if ($renamed) {
        & { $ErrorActionPreference = 'Continue'; docker start $Container 2>&1 | Out-Null }
    }
    if ($renamed -and $LASTEXITCODE -eq 0) {
        Write-Host "  + Previous version restored" -ForegroundColor Green
        Write-RcLog "rollback restored previous container"
    } else {
        Write-Host "  x Automatic rollback failed. The previous container is still named '$RollbackContainer'." -ForegroundColor Red
        Write-Host "    Recover it with: docker rename $RollbackContainer $Container; docker start $Container"
        Write-RcLog "rollback failed"
    }
    $script:HadPrevious = $false
}

# -- 1. Check Docker -------------------------------------------------------
Write-Step 1 "Docker environment"
# NOTE: $ErrorActionPreference='Stop' + 2>$null causes PS 5.1 to throw a
# terminating error when native commands write to stderr (PowerShell#4002).
# Isolate native calls in a scriptblock with 'Continue' to avoid this.

function Test-DockerReady {
    # Pre-check: docker CLI must exist (CommandNotFoundException doesn't set $LASTEXITCODE)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    & {
        $ErrorActionPreference = 'Continue'
        $null = & docker info 2>&1
        $LASTEXITCODE -eq 0
    }
}

$dockerOk = Test-DockerReady

# If docker info failed, check if Docker Desktop process is running but daemon
# is still initializing (common on Windows — daemon takes 10-30s after tray
# shows "Running", named pipe may not exist yet)
if (-not $dockerOk) {
    $dockerProc = Get-Process -Name "Docker Desktop", "com.docker.backend" -ErrorAction SilentlyContinue
    if ($dockerProc) {
        Write-Host "  > Docker Desktop is starting, waiting for daemon..." -ForegroundColor Cyan
        for ($retry = 0; $retry -lt 15; $retry++) {
            Start-Sleep -Seconds 2
            if (Test-DockerReady) { $dockerOk = $true; break }
        }
    }
}

if (-not $dockerOk) {
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerCmd) {
        Write-Host "  x Docker is not installed." -ForegroundColor Red
    } else {
        Write-Host "  x Docker daemon is not responding after 30s." -ForegroundColor Red
        Write-Host "    Docker CLI found at: $($dockerCmd.Source)"
    }
    Write-Host ""
    Write-Host "  Install / start Docker Desktop first:"
    Write-Host "    https://docs.docker.com/desktop/setup/install/windows-install/"
    Write-Host ""
    Write-Host "  After installing, start Docker Desktop, wait for it to show 'Running',"
    Write-Host "  then re-run this script."
    return
}

$dv = & { $ErrorActionPreference = 'Continue'; (& docker --version 2>&1) -replace '.*?(\d+\.\d+\.\d+).*', '$1' }
Write-Host "  + Docker $dv" -ForegroundColor Green

Write-Step 2 "Preflight checks"

# -- 1b-0. Disk space (image needs ~7 GB unpacked) --------------------------
try {
    $freeGb = [math]::Floor((Get-PSDrive -Name C -ErrorAction Stop).Free / 1GB)
    if ($freeGb -lt 10) {
        Write-Host "  ! Low disk space: $freeGb GB free on C:. The image needs ~7 GB unpacked." -ForegroundColor Yellow
        Write-RcLog "low disk: ${freeGb}GB"
    }
} catch {}

# -- 1b. WSL2 proxy diagnostics (Docker Desktop on Windows) -----------------
# Docker Desktop 29+ uses WSL2 in NAT mode by default. If the user has a
# proxy at localhost (Clash, V2Ray, etc.), WSL2 cannot reach the host's
# localhost — docker pull will fail even though the proxy is running.
#
# Detection: check .wslconfig for networkingMode and system/env proxy for localhost.
# This is advisory only — we don't block the script, just warn before pull.

function Test-WslLocalhostProxyIssue {
    # Only relevant when Docker uses WSL2 backend
    $dockerInfo = & { $ErrorActionPreference = 'Continue'; & docker info 2>&1 | Out-String }
    if ($dockerInfo -notmatch 'WSL') { return $false }

    # Check if WSL2 is in mirrored networking mode (which fixes localhost access)
    $wslconfig = Join-Path $env:USERPROFILE ".wslconfig"
    if (Test-Path $wslconfig) {
        $content = Get-Content $wslconfig -Raw -ErrorAction SilentlyContinue
        if ($content -and $content -match '(?i)networkingMode\s*=\s*mirrored') {
            return $false  # mirrored mode — localhost works fine
        }
    }

    # Check for localhost proxy in env vars or Windows system proxy
    $proxyVars = @($env:HTTP_PROXY, $env:HTTPS_PROXY, $env:http_proxy, $env:https_proxy)
    foreach ($p in $proxyVars) {
        if ($p -and $p -match '(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])') {
            return $true
        }
    }

    # Check Windows system proxy (Internet Options)
    try {
        $reg = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
        if ($reg.ProxyEnable -and $reg.ProxyServer -match '(localhost|127\.0\.0\.1)') {
            return $true
        }
    } catch {}

    return $false
}

$wslProxyIssue = Test-WslLocalhostProxyIssue
if ($wslProxyIssue) {
    Write-Host "  ! WARNING: Detected localhost proxy + WSL2 NAT mode" -ForegroundColor Yellow
    Write-Host "    Docker Desktop runs inside WSL2, which CANNOT reach Windows' localhost in NAT mode." -ForegroundColor Yellow
    Write-Host "    This will cause 'docker pull' to fail even though your proxy is running." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    Fix (choose one):" -ForegroundColor White
    Write-Host "      1. Enable WSL2 mirrored networking (recommended):" -ForegroundColor White
    Write-Host "         Edit %USERPROFILE%\.wslconfig, add:" -ForegroundColor DarkGray
    Write-Host "           [wsl2]" -ForegroundColor DarkGray
    Write-Host "           networkingMode=mirrored" -ForegroundColor DarkGray
    Write-Host "         Then restart Docker Desktop." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "      2. Use host.docker.internal instead of localhost:" -ForegroundColor White
    Write-Host "         Docker Desktop -> Settings -> Resources -> Proxies:" -ForegroundColor DarkGray
    Write-Host "           HTTP:  http://host.docker.internal:<your-proxy-port>" -ForegroundColor DarkGray
    Write-Host "           HTTPS: http://host.docker.internal:<your-proxy-port>" -ForegroundColor DarkGray
    Write-Host ""
}

# -- 4. Pre-flight: test registry connectivity ------------------------------
# Quick check before entering the retry loop. If registry is unreachable,
# give specific guidance immediately instead of waiting through 3 retries.
$registry = ($ImageRepo -split '/')[0]
$registryOk = $false
try {
    $null = Invoke-WebRequest -Uri "https://${registry}/v2/" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
    $registryOk = $true
} catch {
    # 401 Unauthorized is expected (auth required) — means registry IS reachable
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -in @(401, 403)) {
        $registryOk = $true
    }
}

if (-not $registryOk) {
    Write-Host "  ! Registry '${registry}' is not reachable." -ForegroundColor Yellow
    if ($registry -eq "ghcr.io") {
        Write-Host "    ghcr.io is blocked in mainland China without proxy." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "    Solutions:" -ForegroundColor White
        Write-Host "      1. Configure Docker Desktop proxy:" -ForegroundColor White
        Write-Host "         Docker Desktop -> Settings -> Resources -> Proxies" -ForegroundColor DarkGray
        Write-Host "         HTTP/HTTPS: http://host.docker.internal:<proxy-port>" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "      2. Use a mirror registry:" -ForegroundColor White
        Write-Host '         $env:MIRROR = "your-mirror/wentorai/research-claw"' -ForegroundColor DarkGray
        Write-Host "         irm https://wentor.ai/docker-install.ps1 | iex" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "      3. Build locally (no proxy needed, uses China mirrors):" -ForegroundColor White
        Write-Host "         git clone https://github.com/wentorai/Research-Claw.git" -ForegroundColor DarkGray
        Write-Host "         cd Research-Claw; docker compose up -d --build" -ForegroundColor DarkGray
        Write-Host ""
    } else {
        Write-Host "    Check that the mirror registry '$registry' is accessible." -ForegroundColor Yellow
    }
    Write-Host "    Continuing with pull attempt anyway..." -ForegroundColor DarkGray
    Write-Host ""
}

# -- 4b. Pull latest image (with retry + automatic GHCR fallback) ------------
Write-Step 3 "Pull image"
# Fast reachability probe: a dead proxy or blocked registry makes `docker pull`
# hang for minutes per attempt with zero output. Probe the registry's /v2/
# endpoint first (any HTTP response — incl. 401 — proves reachability; only
# connection-level failure counts as unreachable) so we fail over in seconds.
# NOTE: probe failure does NOT skip pulling entirely — the Docker daemon may
# have its own working proxy (common on Docker Desktop) — it just cuts the
# blind retries from 3 to 1.
function Test-RegistryReachable {
    param([string]$Registry)
    try {
        $null = Invoke-WebRequest -Uri "https://$Registry/v2/" -Method Head -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
        return $true
    } catch {
        # An HTTP-level response (401/404/405...) still proves the registry is
        # reachable. Works for both WebException (PS 5.1) and
        # HttpResponseException (PS 7) — both expose .Response.
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

function Invoke-PullWithRetry {
    param([string]$PullImage)
    $registry = ($PullImage -split '/')[0]
    $maxAttempts = 3
    if (-not (Test-RegistryReachable $registry)) {
        Write-Host "  ! Registry $registry not reachable from this shell (8s probe)." -ForegroundColor Yellow
        Write-Host "    Docker's daemon may still reach it through its own proxy - trying once." -ForegroundColor DarkGray
        $maxAttempts = 1
    }
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        Write-Host "  > Pulling $PullImage (attempt ${attempt}/${maxAttempts})" -ForegroundColor Cyan
        Write-Host "    First install downloads ~2 GB - typically 3-10 min depending on network." -ForegroundColor DarkGray
        Write-Host "    Layer count below advances per finished layer; the seconds tick proves it's alive." -ForegroundColor DarkGray
        if (Invoke-PullWithProgress $PullImage) { return $true }
        if ($attempt -lt $maxAttempts) {
            $backoff = $attempt * 5
            Write-Host "  ! Pull failed - retrying in ${backoff}s..." -ForegroundColor Yellow
            Start-Sleep -Seconds $backoff
        }
    }
    return $false
}

# Layer-count progress for docker pull. With the containerd image store the
# CLI prints only status transitions — a multi-minute big-layer download shows
# zero output and looks like a hang. Byte-level progress does not exist under
# the containerd store, so we render completed-layer count plus an elapsed
# tick every second as the liveness signal. Full docker output is kept in a
# log and dumped on failure.
function Invoke-PullWithProgress {
    param([string]$PullImage)
    $outLog = [System.IO.Path]::GetTempFileName()
    $errLog = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath "docker" -ArgumentList @("pull", $PullImage) `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
        -NoNewWindow -PassThru
    $t = 0
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 1
        $t++
        $content = @(Get-Content $outLog -ErrorAction SilentlyContinue)
        $ids = @($content | Where-Object { $_ -match '^[0-9a-f]{12}:' } |
            ForEach-Object { ($_ -split ':')[0] } | Sort-Object -Unique)
        $done = @($content | Where-Object { $_ -match '^[0-9a-f]{12}: (Pull complete|Already exists)' }).Count
        if ($ids.Count -gt 0) {
            Write-Host -NoNewline ("`r  > Pulling image: $done/$($ids.Count) layers - ${t}s ")
        }
    }
    $proc.WaitForExit()
    $rc = $proc.ExitCode
    Write-Host ""
    if ($rc -ne 0) {
        Write-Host "  ! Pull failed. Last output:" -ForegroundColor Yellow
        @(Get-Content $outLog, $errLog -ErrorAction SilentlyContinue | Select-Object -Last 3) |
            ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    }
    Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
    return ($rc -eq 0)
}

$pullOk = Invoke-PullWithRetry $Image
if (-not $pullOk -and -not $env:MIRROR -and $ImageRepo -eq $AcrRepo) {
    # ACR failed and user didn't explicitly set MIRROR — try GHCR as fallback
    Write-Host "  ! China mirror (ACR) unreachable - trying GHCR fallback..." -ForegroundColor Yellow
    $Image = "${GhcrRepo}:latest"
    $ImageRepo = $GhcrRepo
    $pullOk = Invoke-PullWithRetry $Image
}

if (-not $pullOk) {
    Write-Host "  x Failed to pull image from both ACR and GHCR." -ForegroundColor Red
    Write-Host ""

    # Check if an older local image exists — offer to use it
    $localImage = & { $ErrorActionPreference = 'Continue'; docker images --format "{{.Repository}}:{{.Tag}}" 2>&1 } | Where-Object { $_ -eq $Image -or $_ -like "$($ImageRepo):*" } | Select-Object -First 1
    if ($localImage) {
        Write-Host "  ! Found local image: $localImage" -ForegroundColor Yellow
        Write-Host "    The pull failed but you have a previously downloaded version." -ForegroundColor Yellow
        Write-Host "    To start it manually:" -ForegroundColor Yellow
        Write-Host "      docker run -d --name $Container -p 127.0.0.1:${Port}:${Port} ``" -ForegroundColor DarkGray
        Write-Host "        -v rc-config:/app/config -v rc-data:/app/.research-claw ``" -ForegroundColor DarkGray
        Write-Host "        -v rc-workspace:/app/workspace -v rc-state:/root/.openclaw ``" -ForegroundColor DarkGray
        Write-Host "        --restart unless-stopped $localImage" -ForegroundColor DarkGray
        Write-Host ""
    }

    # Provide targeted diagnostics
    if ($wslProxyIssue) {
        Write-Host "  DIAGNOSIS: WSL2 localhost proxy issue detected (see warning above)." -ForegroundColor Red
        Write-Host "  Your proxy is running, but Docker (inside WSL2) cannot reach it via localhost." -ForegroundColor Red
        Write-Host ""
        Write-Host "  Quickest fix:" -ForegroundColor White
        Write-Host "    1. Open (or create) %USERPROFILE%\.wslconfig" -ForegroundColor White
        Write-Host "    2. Add these lines:" -ForegroundColor White
        Write-Host "         [wsl2]" -ForegroundColor Cyan
        Write-Host "         networkingMode=mirrored" -ForegroundColor Cyan
        Write-Host "    3. Restart Docker Desktop" -ForegroundColor White
        Write-Host "    4. Re-run: irm https://wentor.ai/docker-install.ps1 | iex" -ForegroundColor White
    } else {
        Write-Host "  Possible causes:" -ForegroundColor White
        Write-Host "    - No internet connection" -ForegroundColor White
        Write-Host "    - GHCR transient error (retry later)" -ForegroundColor White
        Write-Host "    - GHCR blocked (mainland China)" -ForegroundColor White
        Write-Host ""
        Write-Host "  Solutions:" -ForegroundColor White
        Write-Host "    1. Configure Docker proxy:" -ForegroundColor White
        Write-Host "       Docker Desktop -> Settings -> Resources -> Proxies" -ForegroundColor DarkGray
        Write-Host "       HTTP/HTTPS: http://host.docker.internal:<proxy-port>" -ForegroundColor DarkGray
        Write-Host "       (Use host.docker.internal, NOT localhost)" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "    2. Use a mirror: " -ForegroundColor White -NoNewline
        Write-Host '$env:MIRROR = "your-mirror"; irm ... | iex' -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "    3. Build locally:" -ForegroundColor White
        Write-Host "       git clone https://github.com/wentorai/Research-Claw.git" -ForegroundColor DarkGray
        Write-Host "       cd Research-Claw; docker compose up -d --build" -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "  See: https://github.com/wentorai/Research-Claw#手动安装--大陆网络--故障排查" -ForegroundColor DarkGray
    return
}
Write-Host "  + Image pulled" -ForegroundColor Green
$imageInfo = & {
    $ErrorActionPreference = 'Continue'
    & docker run --rm --entrypoint node $Image /app/scripts/version-info.cjs --root /app 2>$null
}
if ($imageInfo) {
    Write-Host "  + $imageInfo" -ForegroundColor Green
}

# Recover an interrupted update before starting another one.
$rollbackExists = & { $ErrorActionPreference = 'Continue'; docker ps -a --format "{{.Names}}" 2>&1 } |
    Where-Object { $_ -eq $RollbackContainer }
$existing = & { $ErrorActionPreference = 'Continue'; docker ps -a --format "{{.Names}}" 2>&1 } |
    Where-Object { $_ -eq $Container }
if ($rollbackExists) {
    if ($existing) {
        $currentHealthy = $false
        $currentRunning = & { $ErrorActionPreference = 'Continue'; docker inspect --format '{{.State.Running}}' $Container 2>&1 }
        if ($currentRunning -eq 'true') {
            try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:${Port}/healthz" -UseBasicParsing -TimeoutSec 2
                $currentHealthy = $response.StatusCode -eq 200
            } catch {}
        }
        if ($currentHealthy) {
            & { $ErrorActionPreference = 'Continue'; docker rm -f $RollbackContainer 2>&1 | Out-Null }
        } else {
            $script:HadPrevious = $true
            Restore-PreviousContainer
        }
    } else {
        Write-Host "  ! Found an interrupted update; restoring the previous container first." -ForegroundColor Yellow
        & { $ErrorActionPreference = 'Continue'; docker rename $RollbackContainer $Container 2>&1 | Out-Null }
        & { $ErrorActionPreference = 'Continue'; docker start $Container 2>&1 | Out-Null }
        $existing = $Container
    }
}

# Keep the previous container until the replacement passes its health check.
if ($existing) {
    Write-Host "  > New image is ready - staging existing container for rollback..." -ForegroundColor Cyan
    & { $ErrorActionPreference = 'Continue'; docker stop $Container 2>&1 | Out-Null }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  x Could not stop the existing container; it was left untouched." -ForegroundColor Red
        return
    }
    & { $ErrorActionPreference = 'Continue'; docker rename $Container $RollbackContainer 2>&1 | Out-Null }
    if ($LASTEXITCODE -ne 0) {
        & { $ErrorActionPreference = 'Continue'; docker start $Container 2>&1 | Out-Null }
        Write-Host "  x Could not prepare the existing container for rollback; it was restarted." -ForegroundColor Red
        return
    }
    $script:HadPrevious = $true
    Write-Host "  + Previous version retained until health verification passes" -ForegroundColor Green
}

# Never terminate an unrelated process just because it owns RC's default port.
$portInUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($portInUse) {
    $owners = @($portInUse | ForEach-Object { $_.OwningProcess } | Where-Object { $_ } | Sort-Object -Unique)
    Write-Host "  x Port ${Port} is already used by another process (PID: $($owners -join ', '))." -ForegroundColor Red
    Write-Host "    Stop that service yourself, then re-run this installer." -ForegroundColor Yellow
    Write-Host "    No process was terminated." -ForegroundColor Yellow
    Restore-PreviousContainer
    return
}

# -- 4c. Clean up dangling images (old versions left by previous pulls) -------
$pruned = & { $ErrorActionPreference = 'Continue'; docker image prune -f 2>&1 }
$match = $pruned | Select-String 'reclaimed' | Select-Object -First 1
if ($match) {
    $reclaimed = ($match.ToString()) -replace '.*reclaimed space:\s*', ''
    if ($reclaimed -and $reclaimed -notmatch '^0\s*B') {
        Write-Host "  + Cleaned up old images ($reclaimed)" -ForegroundColor Green
    }
}

# -- 5. Start container ------------------------------------------------------
Write-Step 4 "Start container"
Write-Host "  > Starting container..." -ForegroundColor Cyan
& {
    $ErrorActionPreference = 'Continue'
    docker run -d `
        --name $Container `
        -p "127.0.0.1:${Port}:${Port}" `
        -v rc-config:/app/config `
        -v "rc-data:/app/.research-claw" `
        -v rc-workspace:/app/workspace `
        -v "rc-state:/root/.openclaw" `
        --restart unless-stopped `
        $Image 2>&1 | Out-Null
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "  x Failed to start container." -ForegroundColor Red
    Write-Host "  Possible causes:"
    Write-Host "    - Port $Port already in use (run: Get-NetTCPConnection -LocalPort $Port)"
    Write-Host "    - Container name conflict (run: docker rm $Container)"
    Restore-PreviousContainer
    return
}

# -- 5b. Verify container is actually running (not crash-looping) -----------
Start-Sleep -Seconds 2
$containerRunning = & { $ErrorActionPreference = 'Continue'; docker inspect --format '{{.State.Running}}' $Container 2>&1 }
if ($containerRunning -ne 'true') {
    Write-Host "  ! Container started but exited immediately." -ForegroundColor Yellow
    Write-Host "    Check logs: docker logs $Container" -ForegroundColor Yellow
    Write-Host "    Common fix: docker volume rm rc-config && re-run this script" -ForegroundColor Yellow
    Write-Host "    (This resets config only — chat history and data are preserved)" -ForegroundColor Yellow
    Restore-PreviousContainer
    return
}

# -- 6. Wait for health -----------------------------------------------------
Write-Step 5 "Wait for gateway"
Write-Host "  > First boot initializes OpenClaw inside the container - typically 20-40s." -ForegroundColor Cyan
$ready = $false
$hw = 0
while ($hw -lt $HealthTimeout) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:${Port}/healthz" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
    $hw += 2
    Write-Host -NoNewline ("`r  > Waiting for gateway... ${hw}s / ${HealthTimeout}s ")
}
Write-Host ""

if (-not $ready) {
    Write-Host "  ! Gateway did not become ready within ${HealthTimeout}s." -ForegroundColor Yellow
    Restore-PreviousContainer
    Write-Host "    Diagnostic log: $RcLog"
    return
}

if ($script:HadPrevious) {
    & { $ErrorActionPreference = 'Continue'; docker rm $RollbackContainer 2>&1 | Out-Null }
    $script:HadPrevious = $false
    Write-Host "  + Update verified; previous container removed" -ForegroundColor Green
}

# -- 7. Done -----------------------------------------------------------------
$Url = "http://127.0.0.1:${Port}/"

Write-Host ""
Write-Host ("  Ready!  (total " + (Get-ElapsedText) + ")") -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard:  $Url" -ForegroundColor Cyan
Write-Host "  Logs:       docker logs -f $Container"
Write-Host "  Stop:       docker stop $Container"
Write-Host "  Start:      docker start $Container"
Write-Host "  Update:     irm https://wentor.ai/docker-install.ps1 | iex"
Write-Host ""
Write-Host "  TIP:  First time? Open the Dashboard -> Setup Wizard -> enter your API Key." -ForegroundColor Yellow
Write-Host ""

Start-Process $Url

} # end scriptblock
