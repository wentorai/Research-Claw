# Research-Claw: pull latest from origin (ff-only), install deps, rebuild dashboard + extensions.
# PowerShell version for Windows - invoked by Dashboard → About → "Apply update"
#
# Dual-remote fallback: if the default remote (often Gitee) has no new commits,
# automatically tries GitHub. Mirrors install.sh's Gitee→GitHub pattern.
$ErrorActionPreference = 'Stop'

# Get script directory and project root
$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDir = Split-Path -Parent $ScriptPath
$ProjectRoot = Split-Path -Parent $ScriptDir

# Check if we're in a git repository
if (-not (Test-Path (Join-Path $ProjectRoot '.git'))) {
    Write-Error "Error: not a git repository. Clone https://github.com/wentorai/Research-Claw to use this script."
    exit 1
}

# Change to project root
Push-Location $ProjectRoot

try {
    $env:PATH = (Join-Path $ProjectRoot 'node_modules' '.bin') + [IO.Path]::PathSeparator + $env:PATH

    # Never block on an interactive git credential prompt. The default remote is a
    # Gitee mirror that intermittently 401s for anonymous fetch; without this guard
    # `git pull` hangs on "Username for 'https://gitee.com':" instead of fast-failing
    # into the GitHub fallback below.
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'Never'
    $env:GIT_ASKPASS = 'echo'

    $GithubRepo = "https://github.com/wentorai/Research-Claw.git"

    Write-Host "[update-research-claw] Pulling latest changes..." -ForegroundColor Cyan

    $OldHead = & git rev-parse HEAD 2>$null
    $PreviousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & git pull --ff-only 2>$null
    $OriginPullSucceeded = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $PreviousErrorActionPreference
    if (-not $OriginPullSucceeded) {
        Write-Warning "Origin could not be checked; trying GitHub."
    }

    $NewHead = & git rev-parse HEAD 2>$null
    $GithubFetchSucceeded = $false
    $GithubMergeSucceeded = $false
    if ($OldHead -eq $NewHead) {
        # Default remote had no new commits — try GitHub fallback
        Write-Host "[update-research-claw] Default remote had no updates, trying GitHub..." -ForegroundColor Cyan
        $PreviousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $null = git remote set-url github $GithubRepo 2>$null
        if ($LASTEXITCODE -ne 0) {
            $null = git remote add github $GithubRepo 2>$null
        }
        $null = git fetch github main 2>$null
        $GithubFetchSucceeded = ($LASTEXITCODE -eq 0)
        if ($GithubFetchSucceeded) {
            $null = git merge --ff-only github/main 2>$null
            $GithubMergeSucceeded = ($LASTEXITCODE -eq 0)
        }
        $ErrorActionPreference = $PreviousErrorActionPreference

        if ($GithubFetchSucceeded) {
            if (-not $GithubMergeSucceeded) {
                throw "Update was not completed: GitHub changes could not be fast-forwarded."
            }
        }
        if (-not $OriginPullSucceeded -and -not $GithubFetchSucceeded) {
            throw "Update could not be completed: neither origin nor GitHub could be checked. The existing installation was kept."
        }
        if ($OriginPullSucceeded -and -not $GithubFetchSucceeded) {
            Write-Warning "Origin was checked successfully; GitHub was unavailable, so the origin result is being used."
        }
    } elseif (-not $OriginPullSucceeded) {
        throw "Update could not be completed because origin reported a failure after changing the working copy."
    }

    # Resolve the one Node 22 / ABI 127 runtime used by the Gateway before
    # pnpm touches better-sqlite3. The updater's parent shell may expose a
    # different Node ABI, which must never determine native build outputs.
    $RuntimeJson = & node (Join-Path $ProjectRoot 'scripts' 'node-runtime.cjs') resolve
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($RuntimeJson)) {
        throw "Node 22.16+ (ABI 127) is required; update was not completed."
    }
    $Runtime = $RuntimeJson | ConvertFrom-Json
    $GatewayNode = [string]$Runtime.path
    if ([string]::IsNullOrWhiteSpace($GatewayNode) -or -not (Test-Path $GatewayNode)) {
        throw "The resolved Gateway Node runtime is unavailable; update was not completed."
    }
    $env:PATH = (Split-Path -Parent $GatewayNode) + [IO.Path]::PathSeparator + $env:PATH

    Write-Host "[update-research-claw] Installing dependencies..." -ForegroundColor Cyan
    & $GatewayNode (Join-Path $ProjectRoot 'scripts' 'run-pnpm.cjs') install

    if ($LASTEXITCODE -ne 0) {
        throw "pnpm install failed with exit code $LASTEXITCODE"
    }

    Write-Host "[update-research-claw] Building project..." -ForegroundColor Cyan
    & $GatewayNode (Join-Path $ProjectRoot 'scripts' 'run-pnpm.cjs') build

    if ($LASTEXITCODE -ne 0) {
        throw "pnpm build failed with exit code $LASTEXITCODE"
    }

    # Complete the same idempotent config migration used by install/startup
    # before reporting success. Existing operator values remain authoritative.
    $ConfigPaths = @()
    $ProjectConfig = Join-Path $ProjectRoot 'config' 'openclaw.json'
    $GlobalConfig = Join-Path $env:USERPROFILE '.openclaw' 'openclaw.json'
    if (Test-Path $ProjectConfig) { $ConfigPaths += $ProjectConfig }
    if (Test-Path $GlobalConfig) { $ConfigPaths += $GlobalConfig }
    if ($ConfigPaths.Count -gt 0) {
        & $GatewayNode (Join-Path $ProjectRoot 'scripts' 'ensure-config.cjs') @ConfigPaths
        if ($LASTEXITCODE -ne 0) {
            throw "configuration migration failed with exit code $LASTEXITCODE"
        }
    }

    # Repair exactly one better-sqlite3 ABI mismatch under the pinned runtime,
    # then require the full build/database preflight. Other failure classes do
    # not trigger dependency mutation.
    & $GatewayNode (Join-Path $ProjectRoot 'scripts' 'native-runtime-guard.cjs') `
        --root $ProjectRoot --config $ProjectConfig --require-build --repair-native-abi
    if ($LASTEXITCODE -ne 0) {
        throw "native runtime verification failed with exit code $LASTEXITCODE"
    }

    & $GatewayNode (Join-Path $ProjectRoot 'scripts' 'version-info.cjs') --root $ProjectRoot

    # Install or update research-plugins in the canonical directory shared by
    # plugin discovery and SkillSearch. The Node helper stages and validates the
    # package before it atomically replaces an existing working version.
    $PluginDir = Join-Path $env:USERPROFILE '.openclaw' 'extensions' 'research-plugins'
    $PluginInstaller = Join-Path $ProjectRoot 'scripts' 'install-research-plugins.cjs'
    $PreviousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Write-Host "[update-research-claw] Updating research plugins..." -ForegroundColor Cyan
    & $GatewayNode $PluginInstaller --target $PluginDir
    $PluginInstallExit = $LASTEXITCODE
    $ErrorActionPreference = $PreviousErrorActionPreference
    if ($PluginInstallExit -eq 0) {
        $NewVersion = & $GatewayNode -e "console.log(require(process.argv[1]).version)" (Join-Path $PluginDir 'package.json')
        Write-Host "[update-research-claw] Research plugins -> v$NewVersion" -ForegroundColor Green
    } else {
        $PreviousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & $GatewayNode $PluginInstaller --check --quiet --target $PluginDir 2>$null
        $PluginStillUsable = ($LASTEXITCODE -eq 0)
        $ErrorActionPreference = $PreviousErrorActionPreference
        if ($PluginStillUsable) {
            Write-Warning "Research plugins were not updated; the existing version was kept."
        } else {
            Write-Warning "Research features are temporarily unavailable; the core assistant remains available."
            Write-Warning "Run this updater again to restore research features."
        }
    }

    # Reconcile after the optional plugin update. Missing or partial installs
    # are removed from the load path; complete installs are restored.
    if ($ConfigPaths.Count -gt 0) {
        & $GatewayNode (Join-Path $ProjectRoot 'scripts' 'ensure-config.cjs') @ConfigPaths
        if ($LASTEXITCODE -ne 0) {
            throw "configuration reconciliation failed with exit code $LASTEXITCODE"
        }
    }

    # Validate the exact project config used by the gateway. Preserve a caller's
    # environment instead of leaving OPENCLAW_CONFIG_PATH pointed at a temp file.
    if (Test-Path $ProjectConfig) {
        $HadConfigPath = Test-Path Env:OPENCLAW_CONFIG_PATH
        $PreviousConfigPath = $env:OPENCLAW_CONFIG_PATH
        try {
            $env:OPENCLAW_CONFIG_PATH = $ProjectConfig
            $PreviousErrorActionPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            & $GatewayNode (Join-Path $ProjectRoot 'node_modules' 'openclaw' 'dist' 'entry.js') config validate --json | Out-Null
            $ValidationExit = $LASTEXITCODE
            $ErrorActionPreference = $PreviousErrorActionPreference
            if ($ValidationExit -ne 0) {
                throw "configuration validation failed with exit code $ValidationExit"
            }
        } finally {
            if ($HadConfigPath) {
                $env:OPENCLAW_CONFIG_PATH = $PreviousConfigPath
            } else {
                Remove-Item Env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue
            }
        }
    }

    Write-Host "[update-research-claw] Done. Restart the gateway (Settings → Restart or scripts/run.sh)." -ForegroundColor Green
} catch {
    Write-Error "Update failed: $_"
    exit 1
} finally {
    Pop-Location
}
