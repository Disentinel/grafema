# REG-170: CLI config.yaml vs config.json incompatibility

## Linear Issue
https://linear.app/reginaflow/issue/REG-170/cli-configyaml-vs-configjson-incompatibility

## Problem

`grafema init` creates `config.yaml` but `grafema analyze` reads `config.json`.

```typescript
// init.ts:38
const configPath = join(grafemaDir, 'config.yaml');

// analyze.ts:123
const configPath = join(projectPath, '.grafema', 'config.json');
```

Result: User's config is completely ignored, defaults are used.

## Steps to Reproduce

1. `grafema init /path/to/project`
2. Edit `.grafema/config.yaml`
3. `grafema analyze`
4. Config changes have no effect

## Expected Behavior

Both commands should use the same config format. Recommend YAML as it's more user-friendly.

## Acceptance Criteria

1. Unify config format (YAML preferred)
2. `analyze` reads `config.yaml`
3. Support `include`/`exclude` patterns from config
4. Migration path for existing `config.json` users

## Context

Discovered during 0.1.1-alpha release testing. Critical blocker for onboarding.

## Priority

Urgent
