# REG-171: ServiceDetector - npm workspaces not supported

## Problem

ServiceDetector doesn't recognize npm workspaces. When analyzing a monorepo with `"workspaces"` in root package.json, Grafema finds only the root project, not the actual apps.

## Steps to Reproduce

```bash
# Project structure:
jammers/
  package.json          # has "workspaces": ["apps/frontend", "apps/backend", "apps/telegram-bot"]
  apps/
    frontend/
      package.json
      src/
    backend/
      package.json
      src/
    telegram-bot/
      package.json
      src/

grafema analyze /path/to/jammers
# Result: Found 1 service(s) - "jammers-monorepo"
# Expected: Found 3 service(s) - frontend, backend, telegram-bot
```

## Expected Behavior

ServiceDetector should:

1. Check for `workspaces` field in root package.json
2. Scan workspace directories for services
3. Create separate service entries for each workspace

## Technical Notes

* Also need to support pnpm workspaces (`pnpm-workspace.yaml`)
* Also need to support yarn workspaces
* Consider lerna.json for legacy monorepos

## Acceptance Criteria

1. Detect npm workspaces from package.json
2. Detect pnpm workspaces from pnpm-workspace.yaml
3. Create service for each workspace with package.json
4. Handle nested workspaces (workspace within workspace)

## Context

Critical blocker for onboarding. Most modern JS projects are monorepos.
