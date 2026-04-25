---
name: zombie-process-port-hunt
description: |
  Verify which process actually owns a TCP port before assuming your fresh restart succeeded. Use when:
  (1) you killed an old server and started a new one but behaviour matches the OLD code/data,
  (2) `pkill -f pattern` returned 0 but old behaviour persists,
  (3) you embedded a new asset/binary but the served version is stale,
  (4) any "I just restarted X but I'm getting old results" situation.
  `pkill -f` matches against the process command line — if the live old process was started with `--port 0` (auto-assigned) and got the port you now want, the pattern won't match it. Always verify with `lsof -i :PORT` before debugging deeper.
author: Claude Code
version: 1.0.0
date: 2026-04-25
---

# Zombie Process / Port Owner Verification

## Problem

You restart a server (via your script that does `pkill -f "myserver.*:51833" && start-new`). The new process logs "listening on 51833". You hit the URL and get **the old behaviour** — old bundle, old data, old API responses. You assume your restart failed somehow, or that the cargo build was cached, or that Playwright is caching, or, or, or.

The actual cause: an OLD long-running process was already on 51833, started hours ago with auto-assigned port (`--port 0`). Its command line **does not contain "51833"** so `pkill -f "myserver.*51833"` matched nothing. Your "new" process tried to bind 51833, got `Address in use`, and either crashed silently OR the new one is bound to a different port and the URL hits the old one.

This wasted ~30 minutes during DAI-22 — I rebuilt the bundle three times, re-embedded into the rust binary twice, and "reprofiled" against an unchanged old server before checking `lsof`.

## Decision rule

If you restart a process and get "old" behaviour from the same URL/port:

1. **First** action: `lsof -i :PORT` (or `lsof -nP -iTCP -sTCP:LISTEN | grep PORT`).
2. The PID returned is the actual owner. Check `ps -p <PID> -o pid,etime,command` — its `etime` and `command` will tell you if it's your fresh start or a zombie.
3. If it's a zombie: `kill <PID>` (specific PID, not pattern). Then start fresh.

## Why `pkill -f` misses

`pkill -f pattern` matches against the **full command line** as recorded when the process started. Failure modes:

| Pattern | Misses |
|---|---|
| `pkill -f "myserver.*51833"` | Process started with `--port 0` (port assigned by OS at runtime) |
| `pkill -f "myserver --db prod"` | Process started with `--db PROD` (case sensitivity in your regex) |
| `pkill -f "node.*server.js"` | Process where shell expanded path: `/abs/path/to/node /full/server.js` |
| `pkill -f "rfdb-server"` (broader) | This one works but kills ALL instances — risky if you have a healthy other one |

Bottom line: `pkill -f` is fine for "kill stuff matching this pattern", terrible as proof of "the port owner is now dead".

## Recipe

```bash
# Diagnose
lsof -i :51833                                  # who owns the port?
ps -p <PID> -o pid,etime,user,command           # what did they start as?

# Kill specifically
kill <PID>                                       # graceful TERM
sleep 1; kill -9 <PID> 2>/dev/null              # KILL if still around

# Verify before restart
lsof -i :51833                                  # should be empty

# Then start fresh
./mybinary --port 51833 &
sleep 3
lsof -i :51833                                  # should now show YOUR new PID
```

## Bonus signal

When restart-and-re-test produces stale results, also check:
- **Build artifact freshness**: `ls -la dist/assets/`, `strings binary | grep <hash>` — is the bundle/embed actually new?
- **Browser cache**: hard reload (`Cmd+Shift+R`) or use `headless: true` Playwright with fresh context.
- **CDN / proxy** in the middle: any service-worker or Cloudflare-style cache between client and server.

But always start with `lsof -i :PORT`. It's the cheapest test and rules out the most painful failure mode.

## Project-specific note (Grafema)

`rfdb-server` accepts `--http-port 0` for auto-assignment. CI scripts and editors (vscode extension) often start it that way. The OS reuses ports on a small range, so an auto-assigned `0` can land on a port you're actively trying to use. Always check `lsof` when "the server doesn't behave like the rebuilt binary should".
