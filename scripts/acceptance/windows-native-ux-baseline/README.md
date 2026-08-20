# Windows native install / daily-launch baseline

This directory is a secret-free WUX-T01 evidence projection. It does not claim
that the current source is release-ready.

## Authority boundary

- Frozen original source baseline: RC commit
  `5015be7a72387098f122cb3e7cc4aae32714d4fa`, tree
  `4d22e3cfc334c252d5c3e7c8d606b14a0483b1fa`.
- Historical v18 package baseline: ZIP SHA-256
  `3d8df487f42762334691287b9191d371310bd016996bf7e5000801385d0b5320`.
- The v18 package installed commit `661879c9a4b43833b9c25047e505bb4c3ff4fdc4`.
  It is historical evidence only: current source changed, probes/audits were
  removed, and the v18 `install.sh` also carried a browser-launch delta not
  present in its installed commit.
- Latest user-transported Windows attempt: v20 ZIP SHA-256
  `11e122bba2016d2b3f319239839bd050948870cedddcad7b57c9fafa60fbe35c`.
  It installed exact commit `0fbda5eac478457a721ce500a2b7b04de9027190` but
  failed the final model product probe after 111 seconds. It is red evidence,
  not a release artifact. The legacy `lastRealWindowsArtifact` manifest field
  remains the frozen v18 comparison authority; `latestRealWindowsAttempt`
  records the current attempt.

## Sanitized real-Windows sources

The runtime projections in `regression-fixtures.json` were manually reduced to
non-secret booleans, error classes, timing classes, versions, and commit IDs.
Their source reports were scanned for Setup Token, model-key, and Authorization
header shapes before projection.

| Fixture | Original report SHA-256 | Meaning |
|---|---|---|
| `windows-v16-runtime-red` | `d2b4bfe70dd0f0993ad1eada0c81c7f3c3db273d157f66dcf271028fcc7f7ab3` | listener existed, HTTP/WebSocket timed out; product runtime red |
| `windows-v17-probe-identity-red` | `69b0b2c5a268d747860981cb7d96ae263936833dc2561ce941c09d69c105e434` | HTTP green; synthetic control-UI identity rejected; probe red, product unknown |
| `windows-v18-runtime-interaction-red` | `c98ccab82382a00bc264dada6c8e04320671018c7a4919b54ed1d55c5f7d0926` | HTTP, authenticated RPC and ticks green; QuickEdit/browser interaction gate not green |
| `windows-v19-plugin-cron-red` | package `504d4a305a6e5cf7bf9307f24a5e4db80a072aa2fdf9f635328b9af4d0000479` | exact v1.4.8 plugins were needlessly sent through the network update path, then the Windows Profile cron worker failed under the old 30-second budget |
| `windows-v20-model-probe-red` | package `11e122bba2016d2b3f319239839bd050948870cedddcad7b57c9fafa60fbe35c` | fetch/build/plugins and Profile stage/apply/file verification passed; the final model product probe failed after 111 seconds, but v20 discarded its safe failure class, so the cause remains deliberately unclassified |
| `windows-wux-v2-host-and-alias-red` | JSON `b649f8ad25cbb57aa44c1daa90d3f661d53d681fe4d882e850fd1ef3dff25dfe`; TXT `d7108ef8cbe38d6db1e3075020afcfb0ad4f10052b6f6726f8672b5a3ca21652` | exact listener identity/IPv4/localhost/dispatch green; PS7 missing; Node DNS alias check was not browser authority; PortableGit discovery missed source commit |

The original reports remain outside the repository. These projections contain
no username, absolute Windows path, PID, log body, token, model key, or secret
hash.

## Synthetic fixtures

`foreign-listener-without-receipt`, `stale-owner-receipt`,
`quickedit-enter-stall`, and `browser-dispatch-rejected-with-fallback` are
deliberately synthetic. They test conservative ownership and interaction
decisions; they are not presented as real-Windows process/browser evidence.
`macos-node24-binding-under-node22` is a controlled local reproduction of the
ABI 137-to-127 failure. The interaction test also performs controlled flips:
disabling QuickEdit while progress advances, or accepting the browser dispatch,
must leave the corresponding negative classification.

## Update rule

Any edit to a `sharedSurfaces` file must update its SHA and invalidate every
listed topology's downstream evidence. Never update the hash alone: add the new
red/green evidence that justifies the source change.
