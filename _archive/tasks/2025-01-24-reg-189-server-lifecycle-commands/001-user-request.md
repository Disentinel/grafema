# User Request: REG-189

## Linear Issue

**REG-189: Add `grafema server start/stop` commands for explicit server lifecycle**

- **Priority:** Normal
- **Status:** In Progress
- **Labels:** Improvement

## Context

After REG-181 fix, RFDB server now persists between CLI and MCP sessions. This is correct behavior for multi-client architecture, but leaves orphan servers running.

## Proposal

Add explicit server management commands:

```bash
grafema server start   # Start RFDB server in background
grafema server stop    # Gracefully stop server
grafema server status  # Show if server is running
```

## Benefits

* Users can control server lifecycle
* Clean shutdown when done working
* Visibility into running processes

## Acceptance Criteria

- [ ] `grafema server start` starts detached server
- [ ] `grafema server stop` sends graceful shutdown signal
- [ ] `grafema server status` shows PID and socket path
