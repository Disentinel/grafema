<!-- captured-at: 2026-04-27 -->
<!-- fixture: representative output (hand-curated; check runs against your guarantees.yaml) -->

## check-all
```
Running 7 guarantees from .grafema/guarantees.yaml:

  ✓ no-sql-in-handlers          (0 violations)
  ✓ public-api-no-private-deps  (0 violations)
  ✗ effects-declared            (3 violations)
    - cli:command 'analyze'      declares no effects but PRODUCES_EFFECT FS_WRITE
    - mcp:tool   'add_knowledge' declares no effects but PRODUCES_EFFECT FS_WRITE
    - http:route 'POST /save'    declares no effects but PRODUCES_EFFECT DB_WRITE
  ✓ no-direct-fs-imports        (0 violations)
  ✓ test-coverage-gate          (84.2 %, threshold 80 %)
  ✓ no-circular-imports         (0 violations)
  ✓ all-features-have-contract  (0 violations)

Status: 1 guarantee failed (3 violations)
Exit code: 1
```

## list-available-diagnostic-categories
```
Available diagnostic categories:
  dataflow    - taint propagation, unsafe reads
  shape       - SHAPE / CONTRACT verification
  effects     - effect-surface vs declared effects
  cohesion    - module / package boundary integrity
  naming      - NamingIncongruence (per cognitive-debt research doc)
  imports     - circular, orphan, unresolved imports
```
