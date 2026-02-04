# Steve Jobs - Product Design Review for REG-326

**Date:** 2026-02-04

## Executive Summary

**Would I demo this on stage? YES, with one minor clarification.**

REG-326 delivers exactly what we promised: "What database query produces this API response?" The implementation is clean, the UX is intuitive, and it aligns perfectly with Grafema's core vision. This feature brings backend value tracing into production-ready state.

The `--from-route` flag is a natural extension of our existing trace command. Users will immediately understand how to use it. It answers a fundamental question developers ask constantly.

---

## The Feature: What Problem Does It Solve?

**User Pain Point:**
```
Developer sees API response returning unexpected data
→ Needs to trace WHERE that data comes from
→ Could be from 5 different database queries in the handler
```

**Before REG-326:**
```bash
grafema trace --to "handleInvitations#0"  # See what gets passed in
```

*But not:* "What database query produced the response?"

**After REG-326:**
```bash
grafema trace --from-route "GET /invitations"
# Shows: res.json(formatted) → db.all(SQL) → SELECT WHERE id=?
```

This is fundamental. Developers need this answer constantly.

---

## UX Assessment

### 1. Command Discoverability

**Good:**
- The flag name `--from-route` is self-explanatory ("from" = starting point, "route" = HTTP route)
- Help text is clear: `"Trace from route response (e.g., 'GET /status' or '/status')"`
- Examples show both full pattern and shorthand

**Potential Issue (Minor):**
The three trace modes (regular, sink, route) might be confusing if someone reads help once:
```
grafema trace [pattern]              # Regular trace
grafema trace --to "fn#0.property"   # Sink trace
grafema trace --from-route "GET /"   # Route trace
```

This is acceptable for an advanced tool, but we should make sure the examples are prominent (they are).

**Verdict:** PASS - Discoverable and clear

### 2. Output Clarity

**Human-Readable Output:**
```
Route: GET /status (backend/routes.js:21)

Response 1 (res.json at line 23):
  Data sources:
    [LITERAL] {"status":"ok"} at routes.js:22
    [UNKNOWN] runtime input at routes.js:25
```

**Assessment:**
- Clear structure: route name first, then responses, then sources
- Type labels ([LITERAL], [UNKNOWN], [VARIABLE]) are helpful
- File paths are relative (good for readability)
- Line numbers always present

This is clean. Users will understand immediately what they're looking at.

**JSON Output (Important):**
The implementation now includes proper JSON output structure:
```json
{
  "route": { "name": "GET /status", "file": "...", "line": 21 },
  "responses": [
    {
      "index": 1,
      "method": "json",
      "line": 23,
      "sources": [...]
    }
  ]
}
```

This is structured and consistent with other Grafema JSON outputs. Agents can parse it easily.

**Verdict:** PASS - Output is clear and well-structured

### 3. Error Handling & Guidance

**Scenario: Route not found**
```
Route not found: GET /invalid

Hint: Use "grafema query" to list available routes
```

**Scenario: No responses found**
```
Route: GET /status (backend/routes.js:21)

No response data found for this route.

Hint: Make sure ExpressResponseAnalyzer is in your config.
```

**Assessment:**
- User gets actionable hints (query routes, check config)
- No cryptic errors
- Guidance is accurate and helpful

**Verdict:** PASS - Error messages guide users to solutions

### 4. Performance & Depth Control

The implementation respects the `--depth` option:
```bash
grafema trace --from-route "GET /status" --depth 5
grafema trace --from-route "GET /status" --depth 20
```

This is important for large codebases where data flow might be deep. The CLI correctly passes the depth parameter through to the tracing function.

**Verdict:** PASS - Respects user configuration

---

## Product Vision Alignment

### "AI should query the graph, not read code"

**How REG-326 advances this vision:**

1. **Before:** Agent would need to:
   - Read the route handler file
   - Identify the response call
   - Manually trace variables back through assignments
   - Read database files to find queries

2. **After:** Agent queries:
   ```
   grafema trace --from-route "GET /status"
   ```
   And gets a complete answer from the graph.

**The graph is the superior way to understand code here.** The feature demonstrates this by eliminating file reading entirely.

**Verdict:** STRONG ALIGNMENT - This is exactly what Grafema should enable

---

## Technical Foundation Check

### Correctness of Variable Linking

From Rob's implementation report, the key improvement:
- **Before:** Response calls were linked to stub nodes, losing semantic meaning
- **After:** When `res.json(variable)` is used, links to the actual VARIABLE/PARAMETER/CONSTANT node

**Example:**
```javascript
const statusData = getStatus();
res.json(statusData);  // Now links to the actual statusData variable
```

This is architecturally correct. Stubs would lose information; linking preserves the graph's semantic integrity.

**Verdict:** CORRECT - Proper semantic linking

### Test Coverage

From Kevlin's review and Rob's final report:
- 10 tests in ExpressResponseAnalyzer.linking.test.ts - all passing
  - Local variables, parameters, module constants
  - Fallback behavior when variables aren't found
  - Forward reference handling (temporal dead zone)
- 20 tests in trace-route.test.ts - all passing
  - Route matching (full pattern and shorthand)
  - Output formatting
  - Error cases

The test improvements (stronger assertions, proper JSON output) mean we catch regressions.

**Verdict:** GOOD - Tests communicate intent clearly

---

## Concerns & Limitations

### 1. When Does the Feature NOT Work?

**Scenario:** Complex return values
```javascript
res.json({
  invitations: formatted.map(x => ({ ...x, id: x._id })),  // ObjectExpression
  metadata: getMetadata()
});
```

Here, `traceValues()` will trace the ObjectExpression itself, but not necessarily every property's source. This is a pre-existing limitation noted in Kevlin's review.

**Is this a blocker?** NO - The feature works for simple responses (which are most common). Complex cases get traced, just not deeply into object construction.

**Would I mention this in demo?** Only if asked. It's a reasonable first implementation.

### 2. Named Handler Functions

The original code mentions REG-323 - a fragile issue with named handler functions passed by reference. This doesn't affect REG-326 (response linking), but it could prevent routes from being found in some cases.

**Would I mention this in demo?** No - it's not related to this feature's quality.

### 3. Requires ExpressResponseAnalyzer to be Enabled

The error message handles this well: "Make sure ExpressResponseAnalyzer is in your config."

The analyzer now runs by default (ConfigLoader.ts), so this shouldn't be an issue for most users.

**Verdict:** ACCEPTABLE - Issue is handled gracefully

---

## Demo Readiness Assessment

### The Demo Script

```bash
# Setup
grafema analyze path/to/project

# Demo the feature
grafema trace --from-route "GET /api/users"

# Shows output:
# Route: GET /api/users (backend/routes.js:42)
# Response 1 (res.json at line 47):
#   Data sources:
#     [VARIABLE] userData at routes.js:44
#     [CALL] db.query at routes.js:45

# Agent-friendly demo
grafema trace --from-route "GET /api/users" --json | jq .responses[].sources
```

### Demo Impact

- **Clarity:** Immediately obvious what the feature does
- **Relevance:** Answers a real question developers ask
- **Simplicity:** One command, clear output
- **Extensibility:** Works with both human and agent usage

**Would I show this on stage?**

YES - This is the kind of feature that makes people nod and say "Oh, THAT'S what Grafema does."

The feature is not flashy, but it's **useful**. And usefulness is what matters.

---

## Product Completeness Checklist

| Aspect | Status | Notes |
|--------|--------|-------|
| Solves stated problem | ✓ | "What database query produces this API response?" → Answered |
| UX is intuitive | ✓ | Flag name and output format are clear |
| Error guidance | ✓ | Users get actionable hints |
| Performance | ✓ | Respects --depth option, reasonable complexity |
| Documentation | ✓ | Help text, examples, error messages all clear |
| Tests pass | ✓ | 30 tests covering happy path and edge cases |
| Aligns with vision | ✓ | "Query the graph, not code" - exemplified |
| No hacks | ✓ | Implementation is clean, no workarounds |

---

## Pre-Demo Verification

### Things to verify before demoing:

1. **ExpressResponseAnalyzer is in DEFAULT_CONFIG** ✓
   - ConfigLoader.ts line 85 confirms this

2. **All tests pass** ✓
   - Kevlin's review confirms all 30 tests pass
   - Rob's post-review fixes addressed JSON output and depth handling

3. **JSON output works** ✓
   - `--json` flag now produces structured output
   - Can be piped to jq for filtering

4. **Depth parameter is respected** ✓
   - maxDepth parameter is properly threaded through to traceValues()

5. **Error messages are helpful** ✓
   - Route not found → suggests "grafema query"
   - No response data → suggests checking config

---

## What Could Be Improved (Post-Release)

These are NOT blockers for shipping, but useful follow-ups:

1. **Tracing through object construction** - REG-XXX (Future)
   - Currently traces object expressions but not deeply into property construction
   - Would need extended ASSIGNS_FROM edges in JSASTAnalyzer

2. **Caching for large projects** - Performance optimization
   - Could cache route lookups for repeated queries
   - Profile-driven optimization

3. **GraphQL support** - Beyond HTTP routes
   - Would need graphql-specific route analyzer
   - Out of scope for this release

---

## Final Assessment

### Code Quality: EXCELLENT
- Clean implementation
- Proper semantic linking
- No technical shortcuts
- Tests are comprehensive and communicate intent

### User Experience: EXCELLENT
- Intuitive command syntax
- Clear output formatting
- Helpful error messages
- Respects user configuration

### Product Alignment: EXCELLENT
- Demonstrates core vision perfectly
- Answers a real developer question
- Enables agent-based automation
- No arbitrary limitations

---

## DECISION: APPROVE

**This feature is ready to ship.** It solves the stated problem cleanly, has excellent test coverage, aligns with our vision, and will delight users.

The implementation shows thoughtful engineering:
- Rob's variable linking fix improves semantic accuracy
- Kevlin's code review caught issues (JSON output, depth parameter)
- Tests were improved to be less ambiguous
- Error messages guide users to solutions

**On stage:** "With Grafema, you can now trace any API response back to its data source. Instead of reading code to understand where data comes from, you just run one command. The graph has all the answers."

---

## Sign-Off

**Status:** ✓ APPROVED FOR MERGE

All concerns addressed. Quality bar met. Ready for production.

Steve Jobs agrees with Linus Torvalds - this is the right implementation of the right feature.

---

*Review by Steve Jobs, Product Design Reviewer*
*February 4, 2026*
