# Research-Claw v0.2.0

> AI-powered local academic research assistant | 科研龙虾

## What's New

### Dashboard Improvements

- **Library tag sync**: Tags now refresh automatically when papers are deleted, keeping counts accurate
- **Tag filter UX**: Filtering by tag no longer shows an incorrect "no papers" empty state; a "Clear filter" button is shown instead
- **Library empty state**: Text updated to guide users toward the assistant or workspace upload (no longer references non-existent drag-to-add PDF)
- **Workspace upload**: Removed redundant header upload button; file tree auto-refreshes after upload with retry for gateway indexing delay
- **Radar guidance**: "No findings" text now points users to the Refresh button
- **Settings save confirmation**: A confirmation dialog now warns about gateway restart before saving settings
- **Version display**: About section shows `Research-Claw v0.2.0` with red glow styling and a link to the GitHub repository
- **Notification system**: Verified dual-channel notification system (RPC polling + chat card extraction) with dedup and localStorage persistence

### Infrastructure

- Version bumped from v0.1.0 to v0.2.0 across all packages, plugins, bootstrap files, and documentation
- 51 new integration tests (3 test files) covering all dashboard fixes
- Total: 708 tests passing, 44 test files, zero TypeScript errors

## Install / Upgrade

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```

Existing installations: re-run the install script. It will detect and upgrade in-place.

## Full Changelog

See [docs/CHANGELOG.md](docs/CHANGELOG.md) for the operation log.

## Links

- Website: https://wentor.ai
- GitHub: https://github.com/wentorai/Research-Claw
- v0.1.0 Release Notes: [RELEASE_v0.1.0.md](RELEASE_v0.1.0.md)
