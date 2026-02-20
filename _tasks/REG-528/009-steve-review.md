# REG-528: Steve Jobs — Vision Review

**Date:** 2026-02-20
**Reviewer:** Steve Jobs (Vision)
**Artifact:** Database auto-selection for VS Code extension

---

## Verdict: APPROVE

---

## Vision Alignment: OK

**Core thesis:** "AI should query the graph, not read code."

This bug fix directly unblocks that thesis. Before this change, the VS Code extension was **completely non-functional** — connected to rfdb-server but never selected a database, causing every graph query to fail. All 7 panels showed placeholders. Zero value delivered.

After this change: extension connects and immediately becomes functional. Graph queries work. AI can query the graph.

**This is product-critical infrastructure, not a feature.** Without database auto-selection, the extension is dead weight. Shipping this is prerequisite to shipping anything else.

**Decision to auto-select "default":** Correct. Convention-over-configuration. The CLI creates "default", the Docker demo expects "default", the protocol server defaults to "default". Making users manually select a database when there's only one choice would be hostile UX.

**Error messages are actionable:** When "default" doesn't exist, the error tells you which databases ARE available and instructs you to run `grafema analyze`. Clear, helpful, non-technical. Good.

---

## Architecture: OK

**The fix is minimal and surgical:**
- One new private method: `negotiateAndSelectDatabase()`
- Called in exactly two places: Unix socket path and WebSocket path (DRY)
- No new state, no new configuration, no new commands
- Error handling: graceful, specific to "not found" errors, re-throws everything else

**Complexity:** O(1) per connection. Two API calls (`hello()`, `openDatabase()`) with optional third (`listDatabases()`) only on failure. No retries, no polling, no timers. Fast and predictable.

**Protocol correctness:** The sequence is textbook:
1. Connect
2. Ping (verify liveness)
3. Hello (negotiate protocol)
4. Open database (select workspace)

This is the standard client initialization flow. The extension was skipping steps 3 and 4. Now it doesn't.

**No corners cut:**
- Tests written first (10 new tests, all passing, 133 total)
- Both transports covered (Unix + WebSocket)
- Error paths tested (not found, empty list, network errors, protocol failures)
- Call ordering verified in tests

**No leaky abstractions:**
- Error messages use domain language ("database", "grafema analyze") not protocol internals
- WebSocket fallback handled separately (correct — different failure modes)
- No magic numbers, no hardcoded timeouts

---

## Polish: OK

**Error messages:**
- "No graph databases found. Run `grafema analyze` to create one." ✅
- "Database 'default' not found. Available: test, staging. Run `grafema analyze`..." ✅
- "WebSocket connection failed: [reason]. Make sure rfdb-server is running with --ws-port flag." ✅

Clear. Helpful. Non-condescending. No jargon.

**Code clarity:**
- Method name `negotiateAndSelectDatabase()` describes exactly what it does
- Comments explain why ("Negotiate protocol version and auto-select default database")
- No surprises, no magic

**No technical debt introduced:**
- No TODOs, no FIXMEs
- No commented-out code
- No temporary hacks
- Tests lock the behavior

---

## Would Shipping This Embarrass Us? No.

This is solid engineering:
- Fixes a critical blocker (QA couldn't validate ANY panel)
- Follows protocol spec correctly
- Handles errors gracefully
- Ships with tests
- Works on both transports
- Zero breaking changes

**User impact:**
- Before: Extension connects but shows placeholders everywhere. Silent failure. Looks broken.
- After: Extension connects and works. If it can't work, tells you why and how to fix it.

That's the difference between "this extension is garbage" and "this extension is useful."

---

## Final Recommendation: APPROVE

Ship it. This is prerequisite infrastructure to make the extension functional. The implementation is clean, tested, and correct. No architectural issues. No vision misalignment. No corners cut.

**Next step:** Run 4-Review batch 1 (Вадим auto + Steve) in parallel. If both approve, proceed to batch 2.

---

**Steve Jobs**
Vision Reviewer, Grafema Project
