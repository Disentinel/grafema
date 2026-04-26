# REG-214: Add grafema doctor/diagnose command for troubleshooting

## Problem

When something is wrong, no way to understand why:

* Why 0 modules?
* Why routes not visible?
* Why class has 0 callers?

User is left guessing.

## Expected Behavior

`grafema doctor` command that checks:

```bash
grafema doctor

Checking Grafema setup...

✓ Config file: .grafema/config.yaml
✓ Database: .grafema/graph.rfdb (9674 nodes, 21846 edges)
✗ Graph connectivity: 172 disconnected nodes
  → Run `grafema analyze --clear` to rebuild

✓ Entrypoints: 3 found
  - apps/backend/src/index.ts
  - apps/frontend/src/main.tsx
  - apps/telegram-bot/src/index.ts

✗ Unresolved calls: 987 (expected for external libs)
  → See REG-206 for policy discussion

Recommendations:
  1. Fix disconnected nodes (REG-202)
  2. Consider adding type stubs for React hooks
```

## Checks to Include

- [ ] Config validity (YAML syntax, required fields)
- [ ] Entrypoints found
- [ ] Graph connectivity (disconnected nodes)
- [ ] Common misconfigurations
- [ ] RFDB server status
- [ ] Version compatibility

## Acceptance Criteria

- [ ] `grafema doctor` command exists
- [ ] Outputs actionable recommendations
- [ ] Links to relevant issues/docs
- [ ] Tests pass
