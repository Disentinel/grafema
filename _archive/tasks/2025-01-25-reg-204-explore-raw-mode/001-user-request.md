# User Request: REG-204

## Problem

`grafema explore` fails when run in non-interactive environment (piped input, CI, etc.):

```
Error: Raw mode is not supported
```

## Expected Behavior

Either:

1. Batch mode with command-line arguments
2. Graceful fallback for non-TTY environments
3. Clear error message suggesting alternative

## Acceptance Criteria

- [ ] `grafema explore` works in pipe: `echo "q" | grafema explore`
- [ ] Or: clear error message with suggested alternative
- [ ] Or: batch mode `grafema explore --query "..."`
- [ ] Tests pass
