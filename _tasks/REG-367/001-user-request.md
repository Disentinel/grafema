# REG-367: Plugin execution: replace priority with declarative depends_on

## Goal

Replace `priority` with declarative `depends_on` for plugin execution ordering.

## Problem

- Manual ordering via magic numbers
- Pain inserting between existing plugins (renumbering)
- No visibility into dependencies
- Cannot parallelize independent plugins

## Solution

```typescript
interface PluginConfig {
  id: string;
  depends_on?: string[];
}
```

Engine: DAG -> cycle validation -> toposort -> execute

## Acceptance Criteria

- [ ] `priority` removed
- [ ] `depends_on` added
- [ ] DAG validation on startup
- [ ] Toposort for ordering
- [ ] Migration of existing plugins
- [ ] Tests
