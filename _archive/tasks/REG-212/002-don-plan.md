# Don Melton's Analysis: REG-212 - Add Examples Section to All CLI Commands

## Summary of Findings

### 1. Command Inventory

All CLI commands are defined in `/packages/cli/src/commands/` and registered in `/packages/cli/src/cli.ts`:

| Command | File | Current Help | Needs Examples |
|---------|------|--------------|----------------|
| `init` | `init.ts` | Basic description | Yes |
| `analyze` | `analyze.ts` | Options only | Yes |
| `overview` | `overview.ts` | Minimal | Yes |
| `query` | `query.ts` | Has raw Datalog examples in option description | Yes (main command) |
| `get` | `get.ts` | Basic description | Yes |
| `trace` | `trace.ts` | Has usage comment in file header only | Yes |
| `impact` | `impact.ts` | Has usage comment in file header only | Yes |
| `explore` | `explore.tsx` | Has usage comment in file header only | Yes |
| `stats` | `stats.ts` | Minimal | Yes |
| `coverage` | `coverage.ts` | Basic description | Yes |
| `check` | `check.ts` | Complex - has modes | Yes |
| `server` | `server.ts` | Has subcommands (start/stop/status) | Yes |
| `doctor` | `doctor.ts` | Minimal | Yes |

### 2. Current Pattern Analysis

In `query.ts`, there's already a precedent: the `--raw` option has inline examples in its description. This works but is NOT the right approach for command-level examples.

### 3. Commander.js Best Practice: `addHelpText()`

The correct way to add examples is using `addHelpText('after', ...)`:

```typescript
export const queryCommand = new Command('query')
  .description('Search the code graph')
  .argument('<pattern>', 'Search pattern')
  // ... options ...
  .addHelpText('after', `
Examples:
  grafema query "auth"              Search by name (partial match)
  grafema query "function login"    Search functions only
`)
  .action(async (pattern, options) => { ... });
```

## High-Level Plan

### Phase 1: Define Examples for Each Command

**init:**
```
grafema init                     Initialize in current directory
grafema init ./my-project        Initialize in specific directory
grafema init --force             Overwrite existing config
```

**analyze:**
```
grafema analyze                  Analyze current project
grafema analyze ./my-project     Analyze specific project
grafema analyze --clear          Clear and rebuild graph
grafema analyze -s api-service   Analyze only one service
```

**overview:**
```
grafema overview                 Show project dashboard
grafema overview --json          Output as JSON
```

**query:**
```
grafema query "auth"              Search by name (partial match)
grafema query "function login"    Search functions only
grafema query "class UserService" Search classes only
grafema query "route /api"        Search HTTP routes
grafema query --raw "type(X,\"FUNCTION\")"  Raw Datalog query
```

**get:**
```
grafema get "file.js->scope->FUNCTION->name"     Get node by semantic ID
grafema get "file.js->scope->FUNCTION->name" -j  Output as JSON
```

**trace:**
```
grafema trace "userId"                   Trace variable by name
grafema trace "userId from authenticate" Trace within specific function
grafema trace "config" --depth 5         Limit trace depth
```

**impact:**
```
grafema impact "authenticate"     Analyze change impact
grafema impact "function login"   Impact of specific function
grafema impact -d 3               Limit depth to 3 levels
```

**explore:**
```
grafema explore                   Interactive TUI mode
grafema explore "authenticate"    Start at specific function
grafema explore --callers "login" Batch: show who calls login
grafema explore --callees "main"  Batch: show what main calls
```

**stats:**
```
grafema stats                     Show graph statistics
grafema stats --json              Output as JSON
```

**coverage:**
```
grafema coverage                  Show analysis coverage
grafema coverage --verbose        Show file lists
grafema coverage --json           Output as JSON
```

**check:**
```
grafema check                     Run all guarantee checks
grafema check connectivity        Check graph connectivity
grafema check --guarantee node-creation  Built-in validator
grafema check --list-categories   List available categories
```

**server:**
```
grafema server start              Start RFDB server
grafema server stop               Stop RFDB server
grafema server status             Check server status
```

**doctor:**
```
grafema doctor                    Run all diagnostic checks
grafema doctor --verbose          Show detailed diagnostics
```

### Phase 2: Implementation Approach

1. Add `addHelpText('after', ...)` to each command definition
2. Use consistent formatting:
   - Two-space indent for examples
   - Align descriptions at column 30-35
3. Ensure examples are actually functional

### Phase 3: Testing Strategy

1. Manual verification: Run `grafema <cmd> --help` for each command
2. Verify examples actually work with a test project

## Why This is the RIGHT Way

1. **Commander.js native** - Uses the official API
2. **Clean output** - Examples appear after options
3. **Maintainable** - Examples co-located with command definitions
4. **No side effects** - Adding examples doesn't change behavior

## What Would Be WRONG

- Putting examples only in file header comments (user never sees them)
- Embedding examples in option descriptions (clutters help output)
- Adding a separate `--examples` flag (unnecessary complexity)

## Critical Files

- `/packages/cli/src/commands/query.ts` - Core pattern
- `/packages/cli/src/commands/analyze.ts` - Most options
- `/packages/cli/src/commands/check.ts` - Has modes
- `/packages/cli/src/commands/explore.tsx` - Interactive + batch modes
