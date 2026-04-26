# Steve Jobs Review — REG-378 (Revision)

**Decision: APPROVE**

## Why
- User-facing pain is a hanging CLI — explicit `process.exit(exitCode)` ensures a reliable finish.
- Change is surgical and doesn’t compromise architecture; it’s a CLI lifecycle guarantee.
- Reduced stats polling removes avoidable load that could contribute to the hang.

## Caveats
- Must ensure all writes/flushes complete before exit.
- Verify on ToolJet once Node is available.

## Verdict
Approved to implement with forced exit after clean shutdown.
