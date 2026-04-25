# REG-217: CLI Warnings Summary Should Be Actionable with Details Commands

## Problem

After analysis:

```
Warnings: 8
```

That's it. User doesn't know:

* Which warnings?
* What to do about them?
* Are they critical?

## Expected Behavior

Actionable warning summary:

```
Warnings: 8
  - 172 disconnected nodes (run `grafema check connectivity`)
  - 987 unresolved calls (run `grafema check calls`)
  - 45 missing assignments (run `grafema check dataflow`)

Run `grafema check --all` for full diagnostics.
```

## Related

* REG-213: grafema doctor command (higher-level diagnostics)
* This issue: per-warning details and dedicated check commands

## Acceptance Criteria

- [ ] Warning summary shows categories
- [ ] Each warning type has a command for details
- [ ] Commands show affected nodes/files
- [ ] Tests pass
