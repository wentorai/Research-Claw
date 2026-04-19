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
    $GithubRepo = "https://github.com/wentorai/Research-Claw.git"

    Write-Host "[update-research-claw] Pulling latest changes..." -ForegroundColor Cyan

    $OldHead = & git rev-parse HEAD 2>$null
    & { $ErrorActionPreference = 'Continue'; git pull --ff-only 2>$null }

    $NewHead = & git rev-parse HEAD 2>$null
    if ($OldHead -eq $NewHead) {
        # Default remote had no new commits — try GitHub fallback
        Write-Host "[update-research-claw] Default remote had no updates, trying GitHub..." -ForegroundColor Cyan
        & {
            $ErrorActionPreference = 'Continue'
            $null = git remote set-url github $GithubRepo 2>$null
            if ($LASTEXITCODE -ne 0) {
                $null = git remote add github $GithubRepo 2>$null
            }
            $null = git fetch github main 2>$null
            if ($LASTEXITCODE -eq 0) {
                $null = git merge --ff-only github/main 2>$null
            }
        }
    }

    Write-Host "[update-research-claw] Installing dependencies..." -ForegroundColor Cyan
    # Use pnpm from local node_modules if available, otherwise from PATH
    $pnpmPath = Join-Path $ProjectRoot 'node_modules' '.bin' 'pnpm'
    if (Test-Path $pnpmPath) {
        & $pnpmPath install
    } else {
        pnpm install
    }

    if ($LASTEXITCODE -ne 0) {
        throw "pnpm install failed with exit code $LASTEXITCODE"
    }

    Write-Host "[update-research-claw] Building project..." -ForegroundColor Cyan
    if (Test-Path $pnpmPath) {
        & $pnpmPath build
    } else {
        pnpm build
    }

    if ($LASTEXITCODE -ne 0) {
        throw "pnpm build failed with exit code $LASTEXITCODE"
    }

    Write-Host "[update-research-claw] Done. Restart the gateway (Settings → Restart or scripts/run.sh)." -ForegroundColor Green
} catch {
    Write-Error "Update failed: $_"
    exit 1
} finally {
    Pop-Location
}
