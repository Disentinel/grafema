# Phase 7: Guarantees — Codify Invariants

## Prerequisites
- Phase 3 complete (features/components validated)
- Phase 5 or 6 partially complete (ownership and/or intent known)

## What to do

Turn implicit conventions into explicit `grafema check` rules.

### 7.1 Detect candidate invariants

Look for patterns that are ALMOST universal — they hold for N-1 cases and break in 1-2:

```
"Every POST/PUT/DELETE handler has auth middleware... except 2:
 POST /api/support/impersonate
 DELETE /api/admin/cache
 
 Should every mutating endpoint require auth? If yes, I'll write a 
 guarantee rule. Those 2 become violations to investigate."
```

Common invariant patterns:
- **Auth guards**: entry points with/without auth middleware
- **Validation**: handlers with/without input validation
- **Error handling**: try/catch coverage on IO operations
- **Naming conventions**: getX() should be pure (no mutations)
- **Import boundaries**: no direct cross-component imports (go through API)
- **Effect containment**: pure modules should stay pure

### 7.2 Show the pattern with exceptions

Always show what's true AND what breaks it:

```
"Pattern detected: all database access goes through Repository classes.
 38/40 DB calls use a Repository. 2 exceptions:
 - orders/checkout.ts:142 — direct SQL query
 - workers/sync.ts:89 — direct table access
 
 Want to make this a guarantee? 
 Future direct DB access would be caught by grafema check."
```

### 7.3 Write guarantee rules

If user agrees, write Datalog rule to `.grafema/guarantees.yaml`:

```yaml
- name: "All mutating endpoints require auth"
  description: "POST/PUT/DELETE handlers must have GUARDS edge from auth middleware"
  severity: error
  rule: |
    violation(Handler, File) :-
      node(Handler, "FUNCTION"),
      attr(Handler, "metadata.route.method", Method),
      member(Method, ["POST", "PUT", "DELETE"]),
      attr(Handler, "file", File),
      not edge(_, Handler, "GUARDS").
```

Show preview of what it catches:
```
"Rule written. Currently catches 2 violations:
 - POST /api/support/impersonate (no auth)
 - DELETE /api/admin/cache (no auth)
 
 grafema check will flag these. Fix them or mark as intentional exceptions."
```

### 7.4 Handle exceptions

| User says | Agent does |
|-----------|-----------|
| "Both are bugs, should have auth" | Leave as violations. Create fix tasks. |
| "impersonate is intentional — internal tool" | Add exception to rule. KB: DECISION "impersonate endpoint intentionally unauthed — internal use only." |
| "I'm not sure about this pattern" | Don't create guarantee yet. Mark as CANDIDATE in KB. Revisit later. |

### 7.5 Security-relevant guarantees

Pay special attention to security patterns — these are the "wow" findings:

```
"Security finding: I can trace a path from user input (req.body) 
 to SQL query without sanitization in 3 endpoints.
 
 Want me to create a guarantee: 'All user input to DB paths must 
 pass through validation'?"
```

## Completion
- >= 3 guarantee rules defined
- Or: user explicitly said "no guarantees needed" (small project)

## Artifacts
- `.grafema/guarantees.yaml` rules
- KB: DECISION entries for intentional exceptions
- Linear tasks for violation fixes
