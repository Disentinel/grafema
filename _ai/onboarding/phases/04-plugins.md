# Phase 4: Plugins — Teach the Graph Your Patterns

## Prerequisites
- Phase 2 complete (features discovered)
- During phases 2–3, unresolved patterns were identified

## What to do

Find custom patterns the generic analyzer missed. Write plugins to handle them.

### 4.1 Identify candidates

```
find_calls where target is unresolved or unknown
Group by receiver name / pattern
Sort by frequency (most calls first)
```

Common patterns to look for:
- Custom ORM/query builder (DataPipe.query, Model.find, etc.)
- Internal event bus (EventBridge.emit, bus.publish, etc.)
- Custom RPC/IPC (serviceBus.call, rpc.invoke, etc.)
- Template engines (render('template'), include('partial'))
- Config/feature flags (config.get('flag'), FeatureFlags.isEnabled)
- Decorator patterns (@RequireAuth, @Cached, @Transactional)
- Internal DSL (router.define, schema.field, etc.)

### 4.2 Ask about each pattern

```
"I see [N] calls to [Pattern.method()] across [M] files,
 but I don't know what [Pattern] is. It's not a public npm package.
 
 What does it do? (ORM, event bus, RPC, config, etc.)"
```

### 4.3 Write plugin

Based on the answer, write an enricher plugin. Guide: `.claude/skills/grafema-batch-plugin-development.md`

Always preview before applying:
```
"I wrote a plugin for [Pattern]. Preview:
 - [N] new [EDGE_TYPE] edges to [targets]
 - Example: OrderService.query('orders') → READS_FROM → table:orders
 - Effects: all [Pattern] calls marked as [IO/MUTATION/etc.]
 
 Apply it?"
```

### 4.4 Re-analyze and show delta

After plugin:
```
analyze_project (re-run)
```

Show what changed:
```
"After [Pattern] plugin:
 +[N] edges, CogLoad for [module] dropped [X] → [Y]
 trace_dataflow now works through [Pattern] calls.
 
 New finding: [something interesting the new edges revealed]"
```

The "new finding" is crucial — it proves the plugin was worth writing.

### 4.5 Effects-db entries

If the custom pattern wraps an external service:
```
"[Pattern] wraps PostgreSQL. Want me to add it to your local
 effects-db so all [Pattern] calls get IO effect automatically?"
```

Write to: `.grafema/effects-db/custom.yaml`

### Handling edge cases

| Situation | Agent does |
|-----------|-----------|
| Pattern is too dynamic to trace statically | Explain limitation. Offer: read code manually, add known edges as batch plugin. Report to Grafema devs. |
| Pattern has multiple modes (query vs. mutate) | Write plugin that distinguishes modes by method name or argument. |
| User doesn't know what pattern does | Mark as unknown. Create investigation task. Don't guess. |
| Plugin produces unexpected results | Show discrepancy. Ask user to validate. Fix or revert. |

## Completion
- Unresolved external calls < 30%
- Or: user confirmed remaining unresolved are genuinely dynamic

## Artifacts
- `.grafema/plugins/*.ts` enricher plugins
- `.grafema/effects-db/custom.yaml` entries
- KB: FACT entries about custom patterns
