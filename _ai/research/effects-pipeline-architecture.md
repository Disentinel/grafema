# Effects Pipeline Architecture

**Date:** 2026-04-03
**Context:** REG-1089 session revealed that effects-db and runtime globals resolvers are parallel systems maintaining the same data. This doc describes the unified architecture.

## Problem

Two parallel catalogs of the same symbols:
1. `globalsDb` in `*RuntimeGlobals.hs` — hardcoded Haskell Maps, used at analysis time for resolution
2. `effects-db/*.yaml` — YAML files, used at query time for effect lookup

Adding a symbol requires editing both. They inevitably diverge.

## Design: Effects-DB as Single Source of Truth

### Data Model

```yaml
# effects-db v3 format
schema_version: 3

# Package identification via PURL
purl: "pkg:npm/node@22"

# Module within the package
modules:
  fs:
    readFile:
      effects: [IO, IO:FILE:READ, ASYNC]
    cp:
      effects: [IO, IO:FILE:WRITE, ASYNC, MUTATION]
      since: "16.7"          # not available before Node 16.7
    glob:
      effects: [IO, ASYNC]
      since: "22.0"

  path:
    join:
      effects: [PURE]
    resolve:
      effects: [PURE]
```

### Runtime Version Awareness

Project declares target runtimes in config:
```yaml
# .grafema/config.yaml
runtimes:
  node: ">=18"
  rust: "1.75"
  php: ">=8.1"
```

Lookup behavior:
- `since` > project version → API doesn't exist → ISSUE "API not available in target runtime"
- No `since` → available in all versions
- No runtime config → assume latest (no version filtering)

### Three-Layer Lookup

```
Priority:
1. User overrides      effects-db/overrides/*.yaml    (committed, project-specific)
2. Registry cache      .grafema/effects-cache/         (gitignored, auto-fetched)
3. Bundled defaults    effects-db/runtimes/*.yaml      (committed in grafema repo, offline baseline)
```

### Remote Registry

```
registry.grafema.dev/effects/
  GET  /effects/{purl}              → effects for one package
  POST /effects/check               → batch freshness check
  POST /effects/publish             → publish new/updated effects
```

#### Freshness Protocol

**Problem:** Package version is immutable, but our analysis accuracy improves over time.
Manifests WILL be inaccurate initially. Need transparent invalidation.

**Cache entry metadata:**
```yaml
_meta:
  analyzer_version: "0.3.24"        # grafema version that generated this
  revision: 7                        # server-side revision counter (monotonic)
  fetched_at: "2026-04-03T14:00:00Z"
```

**Update protocol:**
1. On `grafema analyze`: batch check `POST /effects/check` with `[{purl, revision}, ...]`
2. Server responds with only changed entries: `[{purl, new_revision, effects}]`
3. If client `analyzer_version` > cached → force refresh (our analyzer improved)
4. `grafema effects --refresh [purl]` → manual cache invalidation
5. One HTTP request per analyze run, not per symbol. Offline → use cache as-is.

**Server-side invalidation:**
- When a better analyzer is released, server bumps revision for affected packages
- Clients discover on next `check` call
- No push mechanism needed — pull on analyze is sufficient

### GenericRuntimeGlobals (Unified Resolver)

One Haskell module replaces three (`RustRuntimeGlobals`, `HaskellRuntimeGlobals`, `RuntimeGlobals`):

```haskell
module GenericRuntimeGlobals (resolveAll) where

-- | Language-specific name parsing strategy
data NameStrategy
  = RustStrategy     -- split on ::, try all suffixes
  | HaskellStrategy  -- split on ., try qualified and bare
  | JsStrategy       -- split on ., check imports for module source

-- | Resolve unresolved CALL nodes against effects-db entries
resolveAll :: NameStrategy -> EffectsDB -> [GraphNode] -> [PluginCommand]
```

**Data source:** Reads effects-db YAML at startup via `GRAFEMA_EFFECTS_DB` env var (set by orchestrator).

**GLOBAL_DEFINITION nodes carry effects in metadata:**
```haskell
mkGlobalNode name effects = GraphNode
  { gnId = prefix <> name
  , gnType = "GLOBAL_DEFINITION"
  , gnMetadata = Map.fromList
      [ ("effects", MetaList (map MetaText effects))
      , ("source", MetaText "effects-db")
      ]
  }
```

Then `trace_effects` reads effects from node metadata → no separate EffectsLookup needed for resolved globals.

### Coverage Pipeline

```bash
grafema coverage                    # report: unresolved by category, suggested effects-db additions
grafema coverage --suggest          # generate effects-db stubs for unknown symbols
grafema coverage --auto             # for analyzable packages: analyze → manifest → effects-db entry
grafema effects --refresh [purl]    # invalidate cache, re-fetch from registry
grafema effects --publish [purl]    # publish local manifest to registry
```

**Auto-effects discovery loop:**
```
npm package → grafema analyze → ManifestGenerator → manifest.yaml
  → grafema effects --publish → registry.grafema.dev
  → other projects fetch via registry → better coverage
```

### Migration Path

1. **Current state (v2):** Hardcoded globalsDb + separate effects-db YAML. Works, but duplicated.
2. **Step 1:** Effects-db v3 format with `since` field. Backward compatible.
3. **Step 2:** GenericRuntimeGlobals reads effects-db YAML instead of hardcoded maps. Delete 3 modules, add 1.
4. **Step 3:** Registry client in EffectsLookup. Fallback to remote on local miss.
5. **Step 4:** `grafema coverage` + `grafema effects` CLI commands.
6. **Step 5:** manifest → registry publish pipeline.

Steps 1-2 can be done together (eliminate duplication).
Steps 3-5 are independent and can be parallelized.
