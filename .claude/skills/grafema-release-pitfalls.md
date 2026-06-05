---
name: grafema-release-pitfalls
description: |
  Non-obvious pitfalls when publishing Grafema npm packages. Use when:
  (1) npm install fails with ETARGET "no matching version" after release,
  (2) rfdb-server version mismatch warning after fresh install,
  (3) npm publish returns 403 Forbidden on unscoped 'grafema' package,
  (4) platform packages ship stale binaries despite version bump.
  Covers: publish order, optionalDependencies sync, granular token scope,
  rfdb-client package location, and binary tag workflow.
---

# Grafema Release Pitfalls

## Problem
Multiple non-obvious issues cause fresh installs to fail or ship stale
binaries after a Grafema release.

## Pitfall 1: Missing rfdb-client in publish
`@grafema/rfdb-client` lives at `packages/rfdb/` (not `packages/rfdb-client/`).
The release script iterates `packages/*/package.json` — if the publish loop
doesn't know about the name→directory mismatch, rfdb-client gets skipped.

**Symptom:** `npm error ETARGET: No matching version found for @grafema/rfdb-client@0.3.X`

**Fix:** Ensure publish loop includes `packages/rfdb` explicitly.

## Pitfall 2: optionalDependencies version drift
`@grafema/cli` has `optionalDependencies` pointing to platform packages
(`@grafema/grafema-darwin-arm64` etc.). The release script bumps `version`
in all package.json files but does NOT bump `optionalDependencies` values.

**Symptom:** `rfdb-server version mismatch — server v0.3.OLD, expected v0.3.NEW`
because npm resolves the old platform package version.

**Fix:** After version bump, grep for the old version in optionalDependencies
across `packages/cli/package.json` and `packages/grafema/package.json`.

## Pitfall 3: npm granular token scope
npm granular (fine-grained) tokens can be scoped to `@grafema/*`. The unscoped
`grafema` package doesn't match that scope — publish returns 403 Forbidden.

**Symptom:** `403 Forbidden - PUT https://registry.npmjs.org/grafema`
even though `npm owner ls grafema` shows you as owner.

**Fix:** Create a classic token or add `grafema` (unscoped) to the granular
token's package list.

## Pitfall 4: Binary tag must precede release
Release script checks if Rust binaries are stale by comparing commits since
the last `binaries-v*` tag. Must push `binaries-v0.X.Y` tag FIRST, wait for
CI to build (~6 min for Rust), download with `download-platform-binaries.sh`,
then run release.sh.

**Symptom:** `ERROR: Binaries are stale (N Rust commits after binaries-vOLD)`

## Correct Publish Order

```
packages/grafema-darwin-arm64
packages/grafema-darwin-x64
packages/grafema-linux-x64
packages/grafema-linux-arm64
packages/types
packages/rfdb          ← @grafema/rfdb-client (easy to miss!)
packages/util
packages/mcp
packages/api
packages/cli
packages/grafema       ← unscoped, needs classic token or broad scope
```

## Verification
```bash
npm view @grafema/cli@0.3.X dependencies
npm view grafema@0.3.X optionalDependencies
```
Both should show matching version numbers.
