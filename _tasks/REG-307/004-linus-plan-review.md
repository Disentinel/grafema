# Linus's Plan Review: REG-307 - Natural Language Query Support

## High-Level Assessment

This is **the right thing**. Not a hack, not a workaround, not a compromise. It's the correct architectural move.

The feature directly addresses a real UX gap (from REG-177) and aligns perfectly with the core vision: "AI should query the graph, not read code." When the current workflow forces users through `explain -> copy -> paste` to find what's already in the graph, that's the graph failing to be useful.

Don and Joel understood the assignment. Let's review critically.

---

## 1. Did We Do the Right Thing?

**YES.**

The decision to use client-side filtering (Option A) rather than adding server-side scope attributes (Option B) is correct at this stage.

Why?
- We have NO data showing server-side filtering is needed
- We have NO performance problems with current scale
- Adding a schema migration + RFDB attribute for hypothetical scale is premature optimization
- Client-side filtering is simple, testable, and works

When scale becomes a problem, we'll have profiling data. Then we optimize. Not before.

This is textbook "make it work, make it right, make it fast - in that order."

---

## 2. Does It Align With Vision?

**YES.**

Before this feature:
```bash
# User wants to find "response" variable in "fetchData"
grafema explain src/app.ts          # Discover what exists
# Copy semantic ID: src/app.ts->fetchData->try#0->VARIABLE->response
grafema query --raw '...'            # Paste into raw query
```

After this feature:
```bash
grafema query "response in fetchData"
```

The graph goes from opaque to intuitive. This is exactly what "AI should query the graph" means.

---

## 3. Did We Cut Corners?

**NO.**

The plan deliberately limits scope (fuzzy search, type inference, cross-file glob patterns) and documents what's NOT included. This is correct. Get the basics right first, then iterate.

The decision to split on ` in ` (space-padded) to avoid breaking names like `signin` is thoughtful. The decision to use exact scope matching (not substring) is correct for v1 - surprising behavior is worse than requiring more typing.

**However**, there's ONE potential corner cut I want called out:

### File Path Matching

Joel's spec says:
```typescript
if (!semanticId.startsWith(file + '->') && !semanticId.includes('/' + file + '->')) {
  return false;
}
```

This handles both `src/app.ts` and `app.ts` matching the ID `src/app.ts->...`.

**Question: Is this correct, or surprising?**

If I say `grafema query "response in app.ts"` and the file is actually `src/app.ts`, should it match?

**My take:** YES, but it needs to be documented in the help text. Users expect basename matching to work. BUT if there are two files with the same basename (`src/app.ts` and `test/app.ts`), what happens?

**Action needed:**
- Document basename matching behavior in help text
- Add test case for basename collision (should match both, user can disambiguate with full path)
- If ambiguous, show a hint: "Multiple files named app.ts found. Use full path: src/app.ts"

This is not a corner cut YET, but it will be if we ship without documenting the behavior.

---

## 4. Did We Over-Engineer?

**NO.**

The design is simple:
1. Parse query string -> extract type, name, file, scopes
2. Query by type (existing code path)
3. Filter by scope (new code path, pure function)
4. Display with context (reuse FileExplainer logic)

Four functions, all pure except the wiring. Single file change. No new dependencies. Backward compatible.

This is the right level of abstraction.

---

## 5. Are the Test Cases Comprehensive?

**ALMOST.**

Joel's test cases cover:
- Basic parsing (type, name, scopes)
- File vs function scope detection
- Multiple scopes
- Edge case: names containing "in" (signin, xindex)
- Scope matching (file, function, nested)
- Context extraction

**What's MISSING:**

### 5.1 Basename Collision Test

```typescript
it('should match both files with same basename', async () => {
  // Setup: src/app.ts and test/app.ts both have a "response" variable
  const result = runCli(['query', 'response in app.ts'], tempDir);

  // Should find both
  assert.ok(result.stdout.includes('src/app.ts'));
  assert.ok(result.stdout.includes('test/app.ts'));
});

it('should match only specific file with full path', async () => {
  const result = runCli(['query', 'response in src/app.ts'], tempDir);

  // Should find only src/app.ts
  assert.ok(result.stdout.includes('src/app.ts'));
  assert.ok(!result.stdout.includes('test/app.ts'));
});
```

### 5.2 Scope Order Test

Joel's spec says: "Scope order: inner scopes should appear after outer scopes in the ID"

But there's NO test verifying this. What if user says `"x in inner in outer"` but the ID is `outer->inner->x`? Does it match?

**Add test:**
```typescript
it('should match scopes regardless of order in query', () => {
  const id = 'src/app.ts->fetchData->try#0->VARIABLE->x';

  // Both should match (scopes are AND, order doesn't matter)
  assert.strictEqual(matchesScope(id, null, ['fetchData', 'try']), true);
  assert.strictEqual(matchesScope(id, null, ['try', 'fetchData']), true);
});
```

### 5.3 Empty Results Suggestion Test

Joel mentions showing helpful message when no results found, but there's no test.

**Add test:**
```typescript
it('should suggest removing scope when no results found', async () => {
  const result = runCli(['query', 'nonexistent in fetchData'], tempDir);

  assert.strictEqual(result.status, 0); // Not an error, just no results
  assert.ok(result.stdout.includes('Try: grafema query "nonexistent"'));
});
```

### 5.4 --type Flag Override Test

Joel's spec shows handling `--type` flag with scope parsing, but there's no test for `grafema query --type FUNCTION "auth in src/app.ts"`.

**Add test:**
```typescript
it('should respect --type flag with scope', async () => {
  const result = runCli(['query', '--type', 'FUNCTION', 'auth in src/app.ts'], tempDir);

  // Should only find FUNCTION nodes, not VARIABLE
  assert.ok(result.stdout.includes('[FUNCTION]'));
  assert.ok(!result.stdout.includes('[VARIABLE]'));
});
```

**Verdict:** The test plan is GOOD but needs these 4 additional cases. Kent, add them.

---

## 6. Did We Forget Anything?

### 6.1 Documentation

The help text update is good, but we need to document the behavior in `_readme/cli-commands.md` (if that file exists). This is a significant UX improvement - users should know it exists.

**Action:** Check if CLI docs exist. If yes, update them. If no, create Linear issue for v0.2 to add CLI documentation.

### 6.2 Semantic ID Parsing Fragility

The `matchesScope()` function relies on semantic ID format: `file->scope->TYPE->name`.

**What if the format changes?** This is brittle.

**Mitigation:** The `SemanticId.ts` module already defines parsing logic. We should reuse it instead of reimplementing with regex.

**Check:** Does `packages/core/src/core/SemanticId.ts` expose a parsing API we can use?

**If YES:** Use it. Don't roll our own parser.
**If NO:** Add a Linear issue to extract parsing logic into a shared utility (v0.2 tech debt).

For REG-307, Joel's regex approach is acceptable as a v1, but we MUST not let this proliferate. If we're parsing semantic IDs in 3+ places, that's a red flag.

### 6.3 JSON Output

The `--json` flag exists, but the spec doesn't mention whether `scopeContext` is included in JSON output.

**Decision needed:** Should JSON output include the `scopeContext` field?

**My take:** YES. AI agents will use JSON output, and context is valuable. But document it in the schema.

**Action:** Joel, clarify JSON output format. Kent, add test for `--json` with scope context.

### 6.4 Scope Matching: Block Scopes

Joel's spec handles `try#0`, `catch#0`, etc. in context extraction, but what about **matching**?

If user says `grafema query "x in try"`, does it match `try#0`?

**From the regex:** `const scopePattern = new RegExp('->${escapeRegExp(scope)}(->|#\\d+->)');`

**YES, it matches.** The pattern `->try(->|#\d+->)` matches both `->try->` and `->try#0->`.

**GOOD.** But this needs a test case.

**Add test:**
```typescript
it('should match numbered block scopes', () => {
  const id = 'src/app.ts->fetchData->try#0->VARIABLE->x';

  assert.strictEqual(matchesScope(id, null, ['try']), true);
});
```

---

## 7. Potential Gotchas

### 7.1 Performance: Iterating All Nodes

The current `findNodes()` iterates all nodes of a type and filters client-side. For a 10K node graph, this is fine. For a 1M node graph, this is unacceptable.

**Don acknowledged this:** "Note: future optimization opportunity, not a blocker."

**Agreed, but let's set a threshold.**

**Decision:** If REG-307 ships and users report query taking >5 seconds, we IMMEDIATELY create a Linear issue for server-side filtering (v0.2 priority bump).

Don't wait for complaints. In the commit message, add:
```
Performance: Client-side filtering sufficient for current scale (<100K nodes).
If queries exceed 5s, migrate to server-side scope attribute (tracked in REG-XXX).
```

Create the tracking issue NOW (even if it's in backlog). This makes the decision auditable.

### 7.2 Scope Matching: Class vs Method

Semantic IDs for methods: `src/app.ts->UserService->login->VARIABLE->token`

If user says `grafema query "token in UserService"`, does it match?

**From the regex:** YES, because the ID contains `->UserService->`.

**But is this correct?** UserService is a class, login is a method. The token is inside the method, not directly inside the class.

**Should `"token in UserService"` match?**

**My take:** YES. The scope chain is hierarchical. If something is inside a method of a class, it's also "inside" the class. This is intuitive.

**BUT:** If there are two methods in UserService (`login` and `logout`), and both have a `token` variable, `"token in UserService"` returns both. User can disambiguate with `"token in login in UserService"`.

**This needs to be documented in help text and tested.**

**Add test:**
```typescript
it('should match hierarchical scopes (class contains method)', () => {
  const id = 'src/app.ts->UserService->login->VARIABLE->token';

  // Both should match
  assert.strictEqual(matchesScope(id, null, ['UserService']), true);
  assert.strictEqual(matchesScope(id, null, ['login']), true);
  assert.strictEqual(matchesScope(id, null, ['UserService', 'login']), true);
});
```

---

## 8. Final Questions for Don and Joel

### Q1: Semantic ID Parsing

Should we reuse `SemanticId.ts` parsing logic instead of rolling our own regex in `matchesScope()`?

If `SemanticId.ts` doesn't expose a parser, should we extract one (separate ticket)?

### Q2: JSON Output

Confirm `scopeContext` is included in `--json` output. Document the schema.

### Q3: Performance Threshold

Confirm the 5-second threshold for triggering server-side optimization ticket. Create the tracking issue now (even if backlog).

### Q4: Basename Matching

Confirm basename matching is intended behavior (I think it is). Document it in help text. Add collision test.

---

## Verdict

**APPROVED WITH MINOR ADDITIONS**

The plan is solid. The architecture is correct. The decisions are justified.

**Before implementation, Kent must add these test cases:**
1. Basename collision (match multiple files with same name)
2. Basename disambiguation (full path matches only one)
3. Scope order independence (AND logic, order doesn't matter)
4. Empty results suggestion message
5. `--type` flag with scope
6. Numbered block scope matching (`try` matches `try#0`)
7. Hierarchical scope matching (class contains method)
8. JSON output includes `scopeContext`

**Joel must clarify:**
1. JSON output format (include `scopeContext`?)
2. Should we reuse `SemanticId.ts` parser? (If not, create tech debt ticket)

**Don must:**
1. Create Linear issue NOW for server-side filtering (v0.2 backlog, triggered if queries >5s)
2. Confirm help text documents basename matching behavior

**Once these are addressed, proceed to implementation.**

This is good work. The plan is at the right level of abstraction, the decisions are well-reasoned, and the scope is appropriately limited. Ship it.

---

**APPROVED** (pending minor test additions and clarifications above)

---

*Linus Torvalds, High-Level Reviewer*
*"Did we do the right thing, or something stupid?"*
