param([string]$AuthToken)

if ($args.Count -ne 0) {
    throw 'Unknown installer argument.'
}

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion = '22.22.2'
$NodeArchive = "node-v$NodeVersion-win-x64.zip"
$NodeSha256 = '7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c'
$GitVersion = '2.55.0'
$GitRelease = '2.55.0.4'
$GitTag = 'v2.55.0.windows.4'
$GitArchive = "PortableGit-$GitRelease-64-bit.7z.exe"
$GitSha256 = '016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5'
$SevenZipArchive = '7zr.exe'
$SevenZipSha256 = '56b8cc9f4971cef253644fafe54063ed7fdca551d4dee0f8c6baa81b855acd72'
$InstallShSha256 = 'afa18713e02740288e986b8fd1c7b1a6e203c4503ca4f72fd6c501da4a3d5c57'
$InstallShUrl = 'https://wentor.ai/install.sh'
$IssueUrl = 'https://github.com/wentorai/Research-Claw/issues'
$script:PrivateRoot = $null
$script:InstallerSourcePath = $MyInvocation.MyCommand.Path

function Write-Step([string]$Text) {
    Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "  OK  $Text" -ForegroundColor Green
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Add-ProcessPath([string]$PathEntry) {
    if ([string]::IsNullOrWhiteSpace($PathEntry)) { return }
    $parts = @($env:Path -split ';')
    if ($parts -notcontains $PathEntry) {
        $env:Path = "$PathEntry;$env:Path"
    }
}

function New-PrivateRoot {
    $parent = Join-Path $env:LOCALAPPDATA 'Wentor\InstallerTemp'
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $root = Join-Path $parent ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root | Out-Null

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = $identity.User.Value
    & icacls.exe $root '/inheritance:r' "/grant:r" "*${sid}:(OI)(CI)F" `
        '/grant:r' '*S-1-5-18:(OI)(CI)F' '/grant:r' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not create the private installer directory.'
    }
    return $root
}

function Download-VerifiedFile {
    param(
        [string[]]$Urls,
        [string]$Destination,
        [string]$ExpectedSha256,
        [string]$Label
    )

    Add-Type -AssemblyName System.Net.Http
    foreach ($url in $Urls) {
        $stream = $null
        $output = $null
        $client = $null
        try {
            Write-Host "  下载 $Label：$url" -ForegroundColor Gray
            $handler = New-Object Net.Http.HttpClientHandler
            $handler.AllowAutoRedirect = $true
            $handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
            $client = New-Object Net.Http.HttpClient($handler)
            $client.Timeout = [TimeSpan]::FromMinutes(10)
            $response = $client.GetAsync($url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            if (-not $response.IsSuccessStatusCode) {
                throw "HTTP $([int]$response.StatusCode)"
            }
            $total = $response.Content.Headers.ContentLength
            $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $output = New-Object IO.FileStream($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $buffer = New-Object byte[] (1024 * 1024)
            [long]$received = 0
            $lastPercent = -1
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $output.Write($buffer, 0, $read)
                $received += $read
                if ($total -and $total -gt 0) {
                    $percent = [int](($received * 100) / $total)
                    if ($percent -ge ($lastPercent + 5)) {
                        Write-Host ("  进度 {0,3}%  ({1:N1}/{2:N1} MB)" -f $percent, ($received / 1MB), ($total / 1MB))
                        $lastPercent = $percent
                    }
                }
            }
            $output.Flush($true)
            $output.Dispose(); $output = $null
            $stream.Dispose(); $stream = $null
            $actual = Get-Sha256 $Destination
            if ($actual -ne $ExpectedSha256) {
                throw "SHA256 mismatch: expected $ExpectedSha256, received $actual"
            }
            Write-Ok "$Label 下载并校验完成"
            return
        } catch {
            if ($output) { $output.Dispose() }
            if ($stream) { $stream.Dispose() }
            if (Test-Path -LiteralPath $Destination) {
                Remove-Item -LiteralPath $Destination -Force
            }
            Write-Warning "$Label 下载源不可用：$($_.Exception.Message)"
        } finally {
            if ($client) { $client.Dispose() }
        }
    }
    throw "$Label 无法从任何批准源下载。请检查校园网、代理或稍后重试。"
}

function Resolve-BundledAsset {
    param(
        [string]$Name,
        [string]$ExpectedSha256,
        [string]$Label
    )
    if (-not $script:InstallerSourcePath) { return $null }
    $installerDirectory = Split-Path -Parent $script:InstallerSourcePath
    $candidate = Join-Path (Join-Path $installerDirectory 'runtime') $Name
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $candidate -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label 本地资产不能是重解析点。"
    }
    if ((Get-Sha256 $candidate) -ne $ExpectedSha256) {
        throw "$Label 本地资产 SHA256 不匹配。"
    }
    Write-Ok "使用安装包内、已校验的 $Label"
    return $candidate
}

function Test-Node22 {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    try {
        $version = (& $node.Source -p 'process.versions.node').Trim()
        $abi = (& $node.Source -p 'process.versions.modules').Trim()
        return ($version -match '^22\.' -and $abi -eq '127')
    } catch {
        return $false
    }
}

function Ensure-Node22 {
    Write-Step '检查 Node.js 22 运行时'
    if (Test-Node22) {
        Write-Ok "复用 $(& node.exe -v)"
        return
    }

    $runtimeRoot = Join-Path $env:LOCALAPPDATA "Wentor\Runtimes\node-v$NodeVersion-7c93e9d9"
    $nodeExe = Join-Path $runtimeRoot 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe)) {
        $archive = Resolve-BundledAsset -Name $NodeArchive -ExpectedSha256 $NodeSha256 -Label "Node.js v$NodeVersion"
        if (-not $archive) {
            $archive = Join-Path $script:PrivateRoot $NodeArchive
            Download-VerifiedFile -Urls @(
                "https://npmmirror.com/mirrors/node/v$NodeVersion/$NodeArchive",
                "https://nodejs.org/dist/v$NodeVersion/$NodeArchive"
            ) -Destination $archive -ExpectedSha256 $NodeSha256 -Label "Node.js v$NodeVersion"
        }
        $extract = Join-Path $script:PrivateRoot 'node-extract'
        Expand-Archive -LiteralPath $archive -DestinationPath $extract
        $source = Join-Path $extract "node-v$NodeVersion-win-x64"
        if (-not (Test-Path -LiteralPath (Join-Path $source 'node.exe'))) {
            throw 'Node.js 压缩包结构无效。'
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeRoot) | Out-Null
        if (Test-Path -LiteralPath $runtimeRoot) {
            throw "Node.js 目标目录已存在但不完整：$runtimeRoot"
        }
        Move-Item -LiteralPath $source -Destination $runtimeRoot
    }
    Add-ProcessPath $runtimeRoot
    if (-not (Test-Node22)) {
        throw 'Node.js 22 安装完成，但当前 PowerShell 无法使用它。'
    }
    Write-Ok "Node.js $(& node.exe -v)（Wentor 用户级运行时）"
}

function Find-GitBash {
    $portableRoot = Join-Path $env:LOCALAPPDATA "Wentor\Runtimes\PortableGit-$GitRelease-016e8423"
    $candidates = @(
        (Join-Path $portableRoot 'bin\bash.exe'),
        (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Ensure-GitBash {
    Write-Step '检查 Git for Windows'
    $bash = Find-GitBash
    if ($bash) {
        Add-ProcessPath (Join-Path (Split-Path -Parent (Split-Path -Parent $bash)) 'cmd')
        Write-Ok "Git Bash 已就绪"
        return $bash
    }

    Write-Host "  准备免安装 PortableGit $GitVersion（当前用户目录，无需管理员权限）。" -ForegroundColor Gray
    $archive = Resolve-BundledAsset -Name $GitArchive -ExpectedSha256 $GitSha256 -Label "PortableGit $GitVersion"
    if (-not $archive) {
        $archive = Join-Path $script:PrivateRoot $GitArchive
        Download-VerifiedFile -Urls @(
            "https://registry.npmmirror.com/-/binary/git-for-windows/$GitTag/$GitArchive",
            "https://github.com/git-for-windows/git/releases/download/$GitTag/$GitArchive"
        ) -Destination $archive -ExpectedSha256 $GitSha256 -Label "PortableGit $GitVersion"
    }
    $sevenZip = Resolve-BundledAsset -Name $SevenZipArchive -ExpectedSha256 $SevenZipSha256 -Label '7-Zip 提取器 26.02'
    if (-not $sevenZip) {
        $sevenZip = Join-Path $script:PrivateRoot $SevenZipArchive
        Download-VerifiedFile -Urls @(
            'https://www.7-zip.org/a/7zr.exe',
            'https://github.com/ip7z/7zip/releases/download/26.02/7zr.exe'
        ) -Destination $sevenZip -ExpectedSha256 $SevenZipSha256 -Label '7-Zip 提取器 26.02'
    }

    $extract = Join-Path $script:PrivateRoot 'portable-git-extract'
    $extractArguments = @('x', '-y', "-o$extract", $archive)
    & $sevenZip @extractArguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "PortableGit 解压失败，退出码：$LASTEXITCODE"
    }

    $stageLauncher = Join-Path $extract 'git-bash.exe'
    $stagePostInstall = Join-Path $extract 'post-install.bat'
    if (Test-Path -LiteralPath $stagePostInstall) {
        if (-not (Test-Path -LiteralPath $stageLauncher)) {
            throw 'PortableGit 缺少 git-bash.exe。'
        }
        & $stageLauncher '--no-needs-console' '--hide' '--no-cd' '--command=post-install.bat' | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "PortableGit 初始化失败，退出码：$LASTEXITCODE"
        }
    }

    $stageBash = Join-Path $extract 'bin\bash.exe'
    $stageCygpath = Join-Path $extract 'usr\bin\cygpath.exe'
    $stageGit = Join-Path $extract 'cmd\git.exe'
    if (-not (Test-Path -LiteralPath $stageBash) `
        -or -not (Test-Path -LiteralPath $stageCygpath) `
        -or -not (Test-Path -LiteralPath $stageGit)) {
        throw 'PortableGit 压缩包结构无效。'
    }
    $gitVersionText = (& $stageGit --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $gitVersionText -ne 'git version 2.55.0.windows.4') {
        throw "PortableGit 版本校验失败：$gitVersionText"
    }

    $runtimeRoot = Join-Path $env:LOCALAPPDATA "Wentor\Runtimes\PortableGit-$GitRelease-016e8423"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeRoot) | Out-Null
    if (Test-Path -LiteralPath $runtimeRoot) {
        throw "PortableGit 目标目录已存在但不完整：$runtimeRoot"
    }
    Move-Item -LiteralPath $extract -Destination $runtimeRoot

    $bash = Find-GitBash
    if (-not $bash) {
        throw 'PortableGit 已准备完成，但 bash.exe 尚不可用。'
    }
    Add-ProcessPath (Join-Path (Split-Path -Parent (Split-Path -Parent $bash)) 'cmd')
    Write-Ok "PortableGit $GitVersion 已就绪（无需管理员权限）"
    return $bash
}

function Convert-ToPosixPath([string]$WindowsPath, [string]$BashExe) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $BashExe)
    $cygpath = Join-Path $gitRoot 'usr\bin\cygpath.exe'
    if (-not (Test-Path -LiteralPath $cygpath)) {
        throw 'Git for Windows 缺少 cygpath.exe。'
    }
    $converted = (& $cygpath -u $WindowsPath).Trim()
    if ([string]::IsNullOrWhiteSpace($converted) -or $LASTEXITCODE -ne 0) {
        throw "无法转换 Windows 路径：$WindowsPath"
    }
    return $converted
}

function Resolve-InstallSh {
    $localCandidate = $null
    if ($script:InstallerSourcePath) {
        $scriptFile = $script:InstallerSourcePath
        if (Test-Path -LiteralPath $scriptFile) {
            $localCandidate = Join-Path (Split-Path -Parent $scriptFile) 'install.sh'
        }
    }
    if ($localCandidate -and (Test-Path -LiteralPath $localCandidate)) {
        if ((Get-Sha256 $localCandidate) -ne $InstallShSha256) {
            throw '同目录 install.sh 与本安装器冻结的 SHA256 不一致。'
        }
        Write-Ok '使用同目录、已校验的 install.sh'
        return $localCandidate
    }

    $destination = Join-Path $script:PrivateRoot 'install.sh'
    Download-VerifiedFile -Urls @($InstallShUrl) -Destination $destination `
        -ExpectedSha256 $InstallShSha256 -Label 'Research-Claw 安装器'
    return $destination
}

function Write-PrivateTokenFile([string]$Token) {
    $path = Join-Path $script:PrivateRoot 'bootstrap-token.txt'
    [IO.File]::WriteAllText($path, $Token, (New-Object Text.UTF8Encoding($false)))
    & icacls.exe $path '/inheritance:r' '/grant:r' `
        "*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):R" `
        '/grant:r' '*S-1-5-18:F' '/grant:r' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw '无法保护 Bootstrap Profile token 临时文件。'
    }
    return $path
}

function Main {
    Write-Host ''
    Write-Host 'Wentor · Research-Claw 0.8.3 Windows 原生一键安装' -ForegroundColor Red
    Write-Host 'Node 22 → Git for Windows → Research-Claw → Bootstrap Profile' -ForegroundColor DarkGray
    Write-Host '无需 WSL2、Docker Desktop，也不会重启 Windows。' -ForegroundColor Green

    $processor = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
    if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess `
        -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' `
        -or -not $processor -or [int]$processor.Architecture -ne 9 `
        -or [int]$processor.AddressWidth -ne 64 -or [int]$processor.DataWidth -ne 64) {
        throw '此安装器要求原生 Windows x64 与 64 位 PowerShell。'
    }
    if ($AuthToken -and $AuthToken -notmatch '^rca_[A-Za-z0-9_-]{43,}$') {
        throw 'SETUP_TOKEN 格式无效。'
    }

    $script:PrivateRoot = New-PrivateRoot
    Ensure-Node22
    $bash = Ensure-GitBash
    Write-Step '准备 Research-Claw 0.8.3 安装入口'
    $installSh = Resolve-InstallSh
    $installPosix = Convert-ToPosixPath $installSh $bash
    $privatePosix = Convert-ToPosixPath $script:PrivateRoot $bash
    $arguments = @('--noprofile', '--norc', $installPosix)
    if ($AuthToken) {
        $tokenFile = Write-PrivateTokenFile $AuthToken
        $AuthToken = $null
        $tokenPosix = Convert-ToPosixPath $tokenFile $bash
        $arguments += @('--auth-token-file', $tokenPosix)
    }

    $previousTmpDir = $env:TMPDIR
    $previousNative = $env:RC_WINDOWS_NATIVE
    try {
        $env:TMPDIR = $privatePosix
        $env:RC_WINDOWS_NATIVE = '1'
        Write-Step '安装并启动 Research-Claw'
        & $bash @arguments
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "Research-Claw 安装未完成，退出码：$exitCode"
        }
    } finally {
        $env:TMPDIR = $previousTmpDir
        $env:RC_WINDOWS_NATIVE = $previousNative
    }
}

try {
    Main
} catch {
    Write-Host "`n安装未完成：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "请保留非秘密错误信息并提交到：$IssueUrl" -ForegroundColor Yellow
    exit 1
} finally {
    if ($script:PrivateRoot -and (Test-Path -LiteralPath $script:PrivateRoot)) {
        Remove-Item -LiteralPath $script:PrivateRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    $AuthToken = $null
}
