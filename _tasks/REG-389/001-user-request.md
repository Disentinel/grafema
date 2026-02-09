# REG-389: Release 0.2.5-beta

First release through the new release workflow.

## Checklist from Linear

1. Sync all package versions to 0.2.5-beta
2. Build rfdb-server binaries (tag + CI + download)
3. Create stable branch
4. GitHub Settings: NPM_TOKEN secret
5. CHANGELOG.md for 0.2.5-beta
6. Run `./scripts/release.sh 0.2.5-beta --publish`
7. Verify: npx, CI green, stable branch
