# Windows x64 Bootstrap Docker gate operator checklist

This checklist prepares and runs the destructive T10 acceptance gate. It does not replace the approved Spec/Plan and does not make a local image or parser run into Windows evidence.

## 1. Freeze non-secret provenance

- Use a disposable native Windows x64 VM or host with an AMD64 process, Administrator rights, Windows PowerShell 5.1, PowerShell 7, and Docker Desktop running Linux/amd64 containers.
- Publish the candidate and the distinct health-fail image only through the authorized staging registry workflow. Record each remote registry descriptor digest from the registry API or `docker buildx imagetools inspect`; never copy a local Docker `RepoDigests` value into the manifest.
- Fill a private working copy of `windows-bootstrap-docker.manifest.example.json` with the remote repositories/digests, fixture authority/expiry, Profile revisions and raw Capsule digests. Leave the local source SHA and candidate critical-runtime placeholders unchanged: the finalizer derives them from the exact current worktree bytes and rejects a prefilled mismatch. Keep `tag` equal to `latest` because that is the production installer ABI.
- Generate the concrete non-secret manifest from the RC worktree. The finalizer computes the current acceptance harness, production installer, evidence helper, and health-fail entrypoint SHA values; it does not call Docker and does not accept unresolved placeholders:

  ```powershell
  node .\scripts\acceptance\finalize-windows-bootstrap-manifest.cjs `
    .\gate.draft.json --output .\gate.json
  ```

  The finalizer creates `gate.json` itself as strict UTF-8 without a BOM and
  refuses to overwrite an existing path. Do not replace `--output` with shell
  redirection: Windows PowerShell 5.1 redirection does not preserve this byte
  contract.

- Review `gate.json` without adding Token or model-Key fields. Hash it separately for the run record.

## 2. Prepare the secret bundle without disclosure

- Materialize the eleven fixture values from the approved secret manager directly into a new file matching `windows-bootstrap-docker.secret-bundle.schema.json`. Do not place the bundle in Git, chat, shell history, an environment variable, argv, build context, evidence, or a shared directory.
- Use a different bundle path and a different evidence directory for the Windows PowerShell 5.1 and PowerShell 7 runs. Never print or hash individual values.
- Put each bundle under a newly created private parent directory. Make the current user the owner, disable inheritance, and allow access only to the current user, SYSTEM, and built-in Administrators. The harness independently rejects a reparse file, wrong owner, inherited ACE, unexpected Allow ACE, missing current-user read access, invalid JSON type, duplicate value, or nonconforming value.
- Confirm the manifest, bundle, evidence directory, and installer paths are distinct. The evidence directory must not exist before the run.

## 3. Confirm the disposable host is empty

- Confirm containers `research-claw`, `research-claw-rollback`, and `research-claw-t10-probe` do not exist.
- Confirm volumes `rc-config`, `rc-data`, `rc-workspace`, and `rc-state` do not exist.
- Confirm both staging image tag and digest references are absent, there are no dangling images, TCP port 28789 is unused, and the host temp directory has no prior RC installer/acceptance artifacts.
- Confirm no setup Token exists in the process environment. Do not run the gate on a workstation that contains user Research-Claw state.

## 4. Run the two shells serially

Run Windows PowerShell 5.1 first, review cleanup, then restore a clean snapshot or use a second disposable VM for PowerShell 7:

```powershell
powershell.exe -NoProfile -File .\scripts\acceptance\windows-bootstrap-docker.ps1 `
  -ManifestPath .\gate.json -SecretBundlePath .\gate.ps51.secrets.json `
  -EvidenceDirectory .\evidence-ps51 -DisposableHostConfirmed

pwsh.exe -NoProfile -File .\scripts\acceptance\windows-bootstrap-docker.ps1 `
  -ManifestPath .\gate.json -SecretBundlePath .\gate.ps7.secrets.json `
  -EvidenceDirectory .\evidence-ps7 -DisposableHostConfirmed
```

Only export the gate-produced JSON, checksum, screenshots, and non-secret manifest. Verify both runs report all eleven scenarios, six Capsule attestations, secret-free scans, exact old-container/four-volume rollback, and complete task-owned cleanup.

## 5. Dispose of fixture authority

- After both evidence packages are verified, revoke all seven fixture Tokens, rotate or destroy all four fixture model Keys, and record that the fixture authority is no longer usable.
- Remove the ACL-private bundle files through the approved secure-deletion/VM-disposal procedure, then destroy the disposable VM or its encrypted disk snapshot.
- Do not merge, push, publish, release, or deploy from this checklist. T10 remains incomplete until both real Windows runs are independently reviewed and entered into the Task matrix.
