# REG-173: Onboarding: interactive ServiceDiscoveryPlugin for each project

**Labels:** v0.3, Feature
**Linear:** https://linear.app/reginaflow/issue/REG-173/onboarding-interactive-servicediscoveryplugin-for-each-project

## Vision

Current approach of auto-detecting services is fragile. Every project is unique — different structures, conventions, entry points. We need an **interactive discovery phase** that works WITH the user, not against them.

## Problem

Auto-detection fails for:

* Monorepos (npm/pnpm/yarn workspaces)
* TypeScript projects (dist vs src)
* Custom structures (not following conventions)
* Legacy projects (multiple entry points)
* Microservices (multiple independent services)

## Proposed Solution

### Interactive `grafema init` Flow

```
$ grafema init

Analyzing project structure...

Found potential services:
  1. apps/frontend (React app, 45 files)
  2. apps/backend (Express API, 23 files)
  3. apps/telegram-bot (Node.js, 12 files)
  4. scripts/ (Utility scripts, 8 files)

Which services should I analyze? [1,2,3,4 or 'all']
> 1,2,3

For apps/backend, I found multiple potential entry points:
  1. src/index.ts (recommended - TypeScript source)
  2. dist/index.js (compiled output)
  3. src/server.ts (alternative entry)

Which entry point should I use? [1]
> 1

Configuration saved to .grafema/config.yaml
Run 'grafema analyze' to build the graph.
```

### Key Principles

1. **Show, don't assume** — Always show what was detected, let user confirm
2. **Smart defaults** — Pre-select the most likely correct option
3. **Explain reasoning** — "recommended - TypeScript source" not just "1"
4. **Remember choices** — Save to config, don't ask again
5. **Override possible** — User can always edit config.yaml manually

### ServiceDiscoveryPlugin Architecture

Each project type should have its own discovery plugin:

* `MonorepoDiscovery` — npm/pnpm/yarn workspaces
* `TypeScriptDiscovery` — tsconfig.json detection
* `ExpressDiscovery` — Express.js patterns
* `ReactDiscovery` — React/Next/Remix patterns
* `GenericJSDiscovery` — Fallback for unknown structures

Plugins run in order, each can add/refine service definitions.

## Acceptance Criteria

1. Interactive init flow with service selection
2. Entry point selection for each service
3. Clear explanation of each choice
4. Saved to config.yaml for reproducibility
5. `--yes` flag for CI (use defaults, no prompts)
6. Plugin architecture for different project types

## Context

This is the core of good onboarding UX. Auto-magic that fails is worse than asking questions upfront.
