# REG-380: Custom plugins can't import `@grafema/core`

## Source
Found during onboarding test on ToolJet project (2026-02-07).

## Problem
The plugin development docs tell users to write:
```javascript
import { Plugin, createSuccessResult } from '@grafema/core';
```

This fails in real projects because `@grafema/core` is not in the project's `node_modules/`. It only exists within the CLI's dependency tree (workspace or global install).

## Context
- Custom plugins are loaded from `.grafema/plugins/` via dynamic `await import(pathToFileURL(pluginPath).href)`
- Node.js module resolution starts from the plugin file's directory
- `@grafema/core` is a dependency of `@grafema/cli`, NOT of the target project
- Users install `@grafema/cli` (globally or via npx), not `@grafema/core`

## Acceptance Criteria
- Custom plugins can `import { Plugin, createSuccessResult } from '@grafema/core'` without installing it separately
- Works with `npx @grafema/cli analyze` (no global install)
- Works with global install
- No changes required for existing plugin code/documentation
- Tests verify the resolution works
