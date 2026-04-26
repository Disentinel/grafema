# REG-207: HTTP routes not searchable via grafema query

## Problem

Overview shows HTTP routes exist:

```
HTTP routes: 64
```

But cannot search them:

```
grafema query "POST"        → nothing
grafema query "GET /api"    → nothing
```

## Expected Behavior

Ability to search and filter routes:

* `grafema query "POST /api/users"` → finds matching endpoint
* `grafema query "method:POST"` → all POST endpoints
* `grafema query "path:/api/*"` → all /api routes

## Acceptance Criteria

- [ ] HTTP routes searchable via query command
- [ ] Can filter by method (GET, POST, etc.)
- [ ] Can filter by path pattern
- [ ] Tests pass
