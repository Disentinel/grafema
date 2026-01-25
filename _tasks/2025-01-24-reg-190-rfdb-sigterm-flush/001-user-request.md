# REG-190: RFDB server flush data on SIGTERM

## Context

From REG-181 analysis: if user manually kills RFDB server with `kill <pid>`, data may be lost because server doesn't flush on SIGTERM.

## Proposal

Add SIGTERM handler in Rust server that flushes data before exit.

## Acceptance Criteria

- [ ] Server flushes on SIGTERM
- [ ] Server flushes on SIGINT (Ctrl+C)
- [ ] Clean exit after flush
