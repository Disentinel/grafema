# User Request: REG-157

## Linear Issue

**REG-157:** Standardize error messages across CLI commands

## Context

Error messages are inconsistent across CLI commands:

| Command | Pattern | Next Steps? |
| -- | -- | -- |
| init.ts | `✗ No package.json found` + suggestion | YES |
| overview.ts | `✗ No graph database found` + suggestion | YES |
| query.ts | `✗ No graph database found` + suggestion | YES |
| trace.ts | `✗ No graph database found` + suggestion | YES |
| impact.ts | `✗ No graph database found` + suggestion | YES |
| check.ts | `Error: Unknown guarantee` + list | YES |
| check.ts | `Error: No database found` | YES |
| stats.ts | `Error: No database found` | YES (different format) |
| analyze.ts | `Analysis failed with fatal error` | NO |

## Requirements

### Standard format

```
✗ Main error message (1 line, concise)

→ Next action 1
→ Next action 2
```

### Error categories

* **Missing database:** `✗ No database found at .grafema/graph.rfdb` → `→ Run: grafema analyze`
* **Missing package.json:** `✗ No package.json found` → `→ Run: npm init`
* **Invalid argument:** `✗ Invalid <argname>: <value>` → `→ Valid options: ...`
* **Config error:** `✗ Config error in .grafema/config.yaml` → `→ Run: grafema init`
* **File not found:** `✗ File not found: <path>` → `→ Check path and try again`

### Helper function

```typescript
// packages/cli/src/utils/errorFormatter.ts
function exitWithError(title: string, nextSteps?: string[]): never
```

* Uses `console.error()`
* Calls `process.exit(1)`
* No external library needed (✗, → work everywhere)

### Commands to update

* init.ts
* analyze.ts (error section only)
* overview.ts
* query.ts
* trace.ts
* impact.ts
* check.ts
* stats.ts

## Acceptance Criteria

- [ ] Helper function in `errorFormatter.ts`
- [ ] All 8 commands use helper
- [ ] Consistent format: `✗ Error` + `→ Next steps`
- [ ] Messages under 80 characters
- [ ] Next steps are actionable
- [ ] Errors go to stderr
- [ ] All tests pass
