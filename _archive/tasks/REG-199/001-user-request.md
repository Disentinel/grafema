# REG-199: Add --log-file option to CLI analyze command

## Goal

Add ability to write analysis logs to a file for debugging and audit purposes.

## Current behavior

CLI outputs logs only to stdout/stderr. Users must manually redirect output with `2>&1 | tee file.log`.

## Proposed solution

Add `--log-file <path>` option to `grafema analyze` command:

```bash
grafema analyze --log-file .grafema/analysis.log
```

## Acceptance criteria

- [ ] `--log-file` option accepts a file path
- [ ] All log output (info, warn, error) written to the file
- [ ] File is created/overwritten on each run
- [ ] stdout still shows progress (or add `--quiet` to suppress)
- [ ] Path can be relative or absolute
