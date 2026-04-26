# REG-174: CLI analyze: services config field is not implemented

## Problem

`grafema analyze` reads `config.json` but ignores the `services` field completely. The `ProjectConfig` interface only defines `plugins`:

```typescript
interface ProjectConfig {
  plugins?: PluginConfig;  // no services field!
}
```

Even if user manually creates a config with explicit services:

```json
{
  "services": [
    { "name": "backend", "path": "apps/backend", "entryPoint": "src/index.ts" }
  ]
}
```

It's completely ignored. `SimpleProjectDiscovery` runs anyway and overrides everything.

## Expected Behavior

If user specifies `services` in config, use those instead of auto-discovery:

1. Read `services` from config
2. If defined and non-empty, skip auto-discovery
3. Pass services directly to Orchestrator
4. Use specified `entryPoint` for each service

## Acceptance Criteria

1. Add `services` field to `ProjectConfig` interface
2. If `services` defined, skip `SimpleProjectDiscovery`
3. Support `entryPoint` override per service
4. Document config schema

## Context

This is a critical workaround until REG-171, REG-172, REG-173 are fixed. Users can't even manually configure services!
