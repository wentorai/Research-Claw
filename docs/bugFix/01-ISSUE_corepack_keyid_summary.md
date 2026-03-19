# Bug：安装器在较新的 Node/Corepack 环境下会因 `Cannot find matching keyid` 失败
# Bug: installer fails on modern Node/Corepack with `Cannot find matching keyid`

## 问题概述 / Summary

在某些机器上，安装/更新脚本会在“安装依赖”这一步失败，报错如下：

On some machines, the install/update script fails during the dependency step with the following error:

```text
▸ Installing dependencies...
.../corepack.cjs:21535
Error: Cannot find matching keyid
```

这个错误发生在项目依赖真正安装之前。问题本身并不是 `Research-Claw` 的业务依赖损坏，而是 `pnpm` 实际上走到了一个较旧的 Corepack shim，随后 Corepack 在校验 npm registry 当前的签名密钥时失败。

The failure happens before project dependencies are actually installed. The problem is not caused by `Research-Claw` dependencies themselves. Instead, `pnpm` resolves to an older Corepack shim, and Corepack then fails while verifying the current npm registry signing key.

## 环境信息 / Environment

- 操作系统 / OS: macOS（Apple Silicon）
- 复现时观察到的 Node 版本 / Node versions observed during reproduction: `v23.3.0`, `v24.14.0`
- 失败环境里的 Corepack 版本 / Corepack version in the failing environment: `0.29.4`
- 项目声明的包管理器版本 / Package manager declared by the project: `pnpm@9.15.0`
- 复现时项目提交 / Project commit observed during reproduction: `0f297a4`

## 复现步骤 / Reproduction

1. 使用一台 `pnpm` 实际由旧版 Corepack 提供的机器。  
   Use a machine where `pnpm` is actually provided by an older Corepack shim.
2. 在已有项目目录中运行安装脚本：  
   Run the installer in an existing project checkout:

```bash
cd ~/research-claw
bash scripts/install.sh
```

3. 脚本会先更新仓库，然后在依赖安装阶段失败，并出现类似下面的错误。  
   The script first updates the repo, then fails during dependency installation with an error like:

```text
Error: Cannot find matching keyid: {"signatures":[...],"keys":[...]}
```

## 原因分析 / Why this happens

- `package.json` 中固定了 `packageManager: "pnpm@9.15.0"`。  
  `package.json` pins `packageManager: "pnpm@9.15.0"`.
- 当前安装器只检查 `pnpm` 是否“存在于 PATH 中”，没有验证它是否真的可用。  
  The current installer only checks whether `pnpm` exists in `PATH`, but does not verify that it actually works.
- 在部分机器上，这个 `pnpm` 实际上是 Corepack 提供的 shim。  
  On some machines, that `pnpm` is actually a Corepack-provided shim.
- 旧版 Corepack 不认识 npm registry 新的签名密钥，因此在拉取/验证 `pnpm` 时直接失败。  
  Older Corepack versions do not recognize the newer npm registry signing key, so they fail while fetching/verifying `pnpm`.
- 于是安装器在执行 `pnpm install` 时中断，即使项目本身其实可以正常安装。  
  As a result, the installer aborts at `pnpm install` even though the project itself is otherwise installable.

这里还有一个次级问题：

There is also a secondary usability problem:

- 安装器在更新阶段会执行 `git reset --hard HEAD`。  
  The installer runs `git reset --hard HEAD` during update.
- 这会把本地对 `scripts/install.sh` 的临时修复清掉。  
  This removes any local workaround in `scripts/install.sh`.
- 也就是说，即使用户手动修过一次，只要再次运行安装器且修复没有提交，本地补丁就会被覆盖。  
  That means even if a user patches it once locally, the workaround is erased on the next installer run unless the fix has been committed.

## 建议修复方案 / Suggested fix

安装器不应该只相信 `command -v pnpm`。更稳妥的做法是：

The installer should not trust `command -v pnpm` alone. A more robust approach would be:

1. 先验证 `pnpm --version` 是否能够真正执行成功。  
   First verify that `pnpm --version` actually runs successfully.
2. 如果失败，则自动安装一个项目内的独立 `pnpm`，例如放在 `.tools/pnpm`。  
   If that fails, install a project-local standalone `pnpm`, for example under `.tools/pnpm`.
3. 解析并保存这个可用 `pnpm` 的绝对路径。  
   Resolve and store the absolute path of the working `pnpm` binary.
4. 后续所有相关步骤都统一调用这个已解析出的二进制，而不是再次依赖 PATH 重新找 `pnpm`。  
   Use that resolved binary for all later steps instead of resolving `pnpm` from `PATH` again.

建议统一覆盖这些调用点：

Suggested call sites to standardize:

- `pnpm install`
- `pnpm build`
- `pnpm build:dashboard`
- `pnpm rebuild better-sqlite3`
- 任何 reinstall / rebuild fallback 路径  
  Any reinstall / rebuild fallback path

这样可以同时解决：

This would solve all of the following:

- 旧 Corepack shim 导致的签名校验失败  
  Signature verification failures caused by outdated Corepack shims
- PATH 顺序变化导致再次命中坏掉的 `pnpm`  
  Re-hitting the broken `pnpm` because of PATH ordering changes
- 安装流程对宿主机包管理器环境过度依赖的问题  
  Over-reliance on the host machine's package-manager environment

## 本地补丁验证结果 / Local patch result

我在本地做了一个补丁，逻辑是：

I created a local patch with the following behavior:

- 当检测到当前 `pnpm` 不可用时，回退到项目内独立安装的 `pnpm@9.15.0`  
  When the current `pnpm` is unusable, fall back to a project-local `pnpm@9.15.0`
- 将解析出的可用二进制保存到 `PNPM_BIN`  
  Store the resolved working binary in `PNPM_BIN`
- 所有 install/build/rebuild 操作都改为调用 `"$PNPM_BIN"`  
  Use `"$PNPM_BIN"` for all install/build/rebuild operations

在同一台报错机器上，以下命令已经实测成功：

On the same failing machine, the following commands completed successfully:

```bash
/Users/air/research-claw/.tools/pnpm/bin/pnpm install --frozen-lockfile
/Users/air/research-claw/.tools/pnpm/bin/pnpm build
```

## 我实际做过的代码修复 / What I changed in code

为了验证这个问题确实可以从项目侧修复，我在本地分支里做了以下代码修改：

To verify that this issue can be fixed from the project side, I made the following code changes in a local branch:

### 1. `scripts/install.sh`

- 将 `PNPM_VERSION` 从宽泛的 `9` 改为明确的 `9.15.0`。  
  Changed `PNPM_VERSION` from the broad `9` to the explicit `9.15.0`.
- 新增 `RC_PNPM_PREFIX`，将项目内独立安装的 `pnpm` 放到 `.tools/pnpm`。  
  Added `RC_PNPM_PREFIX` so a project-local standalone `pnpm` is installed under `.tools/pnpm`.
- 新增 `PNPM_BIN`，用于保存已经确认可用的 `pnpm` 绝对路径。  
  Added `PNPM_BIN` to store the absolute path of the verified working `pnpm` binary.
- 新增 `activate_private_pnpm()`、`pnpm_cmd_works()`、`install_private_pnpm()`、`ensure_pnpm()`。  
  Added `activate_private_pnpm()`, `pnpm_cmd_works()`, `install_private_pnpm()`, and `ensure_pnpm()`.
- 逻辑上不再只检查 `command -v pnpm`，而是要求 `pnpm --version` 能真正成功执行。  
  The logic no longer trusts `command -v pnpm` alone; it now requires `pnpm --version` to actually succeed.
- 如果系统 `pnpm` / Corepack shim 不可用，则自动安装项目内独立 `pnpm` 并回退使用它。  
  If the system `pnpm` / Corepack shim is unusable, the installer automatically installs and falls back to a project-local standalone `pnpm`.
- 将后续依赖安装、构建、重建操作全部改为调用 `"$PNPM_BIN"`，避免 PATH 顺序变化后再次命中坏掉的系统 `pnpm`。  
  Updated later install/build/rebuild operations to call `"$PNPM_BIN"` directly, preventing PATH order from re-selecting the broken system `pnpm`.
- 覆盖的调用点包括：  
  Updated call sites include:
  - `pnpm install`
  - `pnpm build`
  - `pnpm build:dashboard`
  - `pnpm rebuild better-sqlite3`
  - clean reinstall fallback 中的 `pnpm install` 和 `pnpm build`  
    `pnpm install` and `pnpm build` inside the clean reinstall fallback
- 安装完成后的启动提示从 `pnpm serve` 改成 `bash scripts/run.sh`，避免用户再次直接依赖系统 `pnpm`。  
  The post-install startup hint was changed from `pnpm serve` to `bash scripts/run.sh` so users do not immediately fall back to the system `pnpm` again.

### 2. `scripts/setup.sh`

- 将首次设置完成后的下一步提示从 `pnpm start` 改成 `bash scripts/run.sh`。  
  Changed the post-setup next-step hint from `pnpm start` to `bash scripts/run.sh`.

### 3. `.gitignore`

- 新增 `.tools/`，避免项目内独立安装的 `pnpm` 被误加入版本控制。  
  Added `.tools/` so the project-local standalone `pnpm` directory is not accidentally committed.

### 4. 验证结果 / Verification result

- 在同一台原本会报 `Cannot find matching keyid` 的机器上，依赖安装已成功完成。  
  On the same machine that originally failed with `Cannot find matching keyid`, dependency installation completed successfully.
- 在同一环境下，项目构建也已成功完成。  
  In the same environment, project build also completed successfully.

## 实际结果 / Expected vs Actual

实际结果 / Actual:

- 安装器先更新仓库  
  The installer updates the repository first
- 随后在依赖安装阶段因 Corepack 报 `Cannot find matching keyid` 而失败  
  It then fails during dependency installation with Corepack reporting `Cannot find matching keyid`

期望结果 / Expected:

- 安装器应当能识别并绕过损坏/过旧的 Corepack shim  
  The installer should detect and bypass broken/outdated Corepack shims
- 依赖安装和构建应当可以正常完成  
  Dependency installation and build should complete successfully
- 用户不应该被迫自己排查包管理器签名密钥问题  
  Users should not have to debug package-manager signing key issues themselves

## 相关报错摘录 / Relevant error excerpt

```text
Error: Cannot find matching keyid: {"signatures":[{"sig":"...","keyid":"SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U"}],"keys":[{"expires":null,"keyid":"SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA",...}]}
```
