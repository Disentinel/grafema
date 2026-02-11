---
name: docker-exec-background-process
description: |
  Fix docker exec hanging when starting background processes (servers, daemons) inside containers.
  Use when: (1) docker exec never returns despite using & or nohup, (2) background server started
  in container causes docker exec to hang indefinitely, (3) env_startup_command in SWE-bench or
  similar frameworks times out, (4) setsid/disown needed for proper process detachment in Docker.
  Root cause: docker exec tracks ALL processes in the exec session, not just the top-level PID.
author: Claude Code
version: 1.0.0
date: 2026-02-10
---

# Docker Exec Background Process Detachment

## Problem
When using `docker exec` to start a background process (like a database server) inside a
container, the `docker exec` command hangs indefinitely and never returns, even when using
`&`, `nohup`, or output redirection.

## Context / Trigger Conditions

- `docker exec container bash -c "my-server &"` never returns
- `docker exec container bash -c "nohup my-server > /dev/null 2>&1 &"` still hangs
- Startup commands in frameworks (SWE-bench, mini-SWE-agent) time out at 300/600s
- Any scenario where `docker exec` needs to start a long-running daemon and return

## Root Cause

Docker exec **tracks ALL processes started in the exec session**, not just the top-level
bash process. This is different from regular bash behavior:

1. `&` — creates background job but bash still tracks it in its job table
2. `nohup` — prevents SIGHUP but does NOT create a new session; docker still tracks it
3. Output redirection (`>/dev/null 2>&1`) — prevents output but docker exec still waits
   for all session processes to terminate

Docker exec uses Linux process sessions/groups. All processes started within an exec call
share the same session. Docker waits for the entire session to finish.

## Solution

Use `setsid` + `disown` + stdin/stdout/stderr redirection:

```bash
docker exec container bash -c 'setsid /path/to/server arg1 arg2 </dev/null >/dev/null 2>&1 & disown && sleep 1 && echo "Ready"'
```

**All four components are required:**

| Component | Purpose |
|-----------|---------|
| `setsid` | Creates a NEW session (new session ID, detaches from exec session) |
| `</dev/null` | Prevents stdin inheritance from docker exec |
| `>/dev/null 2>&1` | Prevents stdout/stderr from keeping pipe fds alive |
| `& disown` | Removes job from bash's job table so bash doesn't wait for it |

**Why each is necessary:**
- Without `setsid`: Process stays in docker exec's session → docker waits
- Without `</dev/null`: Process may hold stdin fd → docker waits
- Without `>/dev/null 2>&1`: Process may hold pipe fds (especially with `| tail`) → docker waits
- Without `disown`: Bash waits for background jobs before exiting → docker waits

## Related Problem: Pipe FD Inheritance

A compounding issue occurs when using pipes in the startup command:

```bash
# THIS HANGS: tail waits for EOF, but server inherits the pipe fd
docker exec container bash -c 'my-server 2>&1 | tail -3'
```

If `my-server` spawns child processes with `stdio: 'inherit'` (common in Node.js), those
children inherit the pipe file descriptor. `tail` waits for ALL writers to close the pipe,
but the inherited fd in the child process keeps it open forever.

**Fix:** Don't pipe server output. Use `>/dev/null 2>&1` or write to a log file:

```bash
# Instead of piping, redirect to file and read separately
docker exec container bash -c 'my-server > /tmp/server.log 2>&1 & sleep 2 && tail -3 /tmp/server.log'
```

## Verification

After running the startup command:
1. `docker exec` should return promptly (within the `sleep` duration)
2. `docker exec container ps aux` should show the server process still running
3. The server should be accessible (check socket, port, etc.)

## Example: Starting rfdb-server in SWE-bench

```yaml
# mini-SWE-agent config
run:
  env_startup_command: |
    ln -sf /opt/grafema/node_modules/.bin/grafema /usr/local/bin/grafema && \
    cp /opt/node_modules/@grafema/rfdb/prebuilt/linux-x64/rfdb-server /usr/local/bin/rfdb-server && \
    chmod +x /usr/local/bin/rfdb-server && \
    setsid /usr/local/bin/rfdb-server /testbed/.grafema/graph.rfdb \
      --socket /testbed/.grafema/rfdb.sock </dev/null >/dev/null 2>&1 & disown && \
    sleep 2 && echo "Server ready"
```

## What Does NOT Work

```bash
# FAILS: nohup doesn't create new session
docker exec container bash -c 'nohup my-server &'

# FAILS: output redirection alone isn't enough
docker exec container bash -c 'my-server > /dev/null 2>&1 &'

# FAILS: disown alone isn't enough (still in same session)
docker exec container bash -c 'my-server & disown'

# FAILS: even all three without setsid
docker exec container bash -c 'nohup my-server > /dev/null 2>&1 & disown'
```

## Notes

- `setsid` is available on most Linux distributions (part of util-linux)
- The `sleep` after `disown` gives the server time to initialize before the script continues
- If the server needs to be verified running, check its pidfile or socket after the sleep
- On macOS Docker Desktop, x86_64 emulation adds ~10x latency to all operations
- For SWE-bench/mini-SWE-agent, `env_startup_command` runs via `docker exec bash -c "..."`,
  so this pattern applies directly
