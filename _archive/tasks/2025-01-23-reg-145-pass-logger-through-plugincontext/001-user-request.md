# User Request: REG-145

## Linear Issue

**Title:** Pass Logger through PluginContext

**Description:**

Plugins currently use `console.log()` directly, bypassing the --quiet flag and making logs uncontrollable. We need to pass a Logger instance through PluginContext so plugins can use structured logging.

## Implementation (from issue)

1. Add `logger: Logger` to PluginContext interface in `packages/types/src/plugins.ts`
2. Create logger in Orchestrator based on logLevel config
3. Pass logger to PluginContext in runPhase()
4. Update plugins to use `context.logger.info()` instead of `console.log()`

## Acceptance Criteria

- [ ] Logger available in PluginContext
- [ ] `--quiet` actually suppresses plugin output
- [ ] `--verbose` shows more detail

## Dependencies

REG-78 (infrastructure complete)
