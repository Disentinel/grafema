# REG-326: Backend value tracing: trace from res.json() to data source

## Problem

Current tracing stops at `RESPONDS_WITH` edge. We can find WHAT the handler returns but not WHERE that data comes from.

## Example

```
http:route ──RESPONDS_WITH──> res.json({ invitations: formatted })
```

Missing trace:

```
formatted ← invitations.map(...)
         ← db.all(SQL_QUERY)
         ← SQL: SELECT ... WHERE invitee_id = ?
```

## Goal

Answer: "What database query produces this API response?"

## Approach Options

1. **Extend** `grafema trace`: Follow ASSIGNED_FROM chain from response argument
2. **New** `grafema trace --to-sink`: Reverse trace from sink to sources
3. **RESPONDS_WITH metadata**: Store traced value sources in edge metadata

## Acceptance Criteria

- [ ] Given http:route, can trace response value to data source
- [ ] Works for: variables, function calls, database queries
- [ ] CLI command or MCP tool available

## Dependencies

* REG-324 (responseDataNode fix) - for reliable frontend←backend link
