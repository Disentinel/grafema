# Bug Report: Segmentation fault when running multiple Claude Code instances in parallel

## Summary

Claude Code crashes with segmentation fault when running multiple instances in parallel (e.g., in git worktrees workflow).

## Environment

- **Claude Code version**: 2.1.19
- **Node.js version**: v20.13.1
- **OS**: macOS 13.6.6 (Ventura)
- **Architecture**: x86_64 (Intel Mac)
- **Kernel**: Darwin 22.6.0

## Steps to Reproduce

1. Set up multiple git worktrees for parallel development
2. Run Claude Code in 2+ terminals simultaneously (in different worktree directories)
3. Work normally in each instance
4. Eventually (~1 in 10-15 sessions), one instance crashes with segfault

## Expected Behavior

Claude Code should run stably in parallel instances without crashes.

## Actual Behavior

```
[1]    7182 segmentation fault  claude
```

The crash occurs:
- With or without `--dangerously-skip-permissions` flag
- Randomly during session (not tied to specific command)
- Approximately 1 in 10-15 sessions

## Workaround

Restart Claude Code and use `/resume` to continue the session. This works reliably.

## Additional Context

Using Claude Code with git worktrees workflow where 2-8 parallel instances may run simultaneously in different terminal tabs. Each instance works in its own worktree directory.

No crash logs found in `~/Library/Logs/DiagnosticReports/`.

## Possible Cause

Race condition in shared resource access (possibly `~/.claude` directory, config files, or socket connections) when multiple instances run concurrently.
