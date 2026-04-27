<!-- captured-at: 2026-04-27 -->
<!-- fixture: representative output (hand-curated) -->

## init-output
```
Scanning packages/ (depth 3) ...
  Found 9 services:
    - @grafema/util  (TypeScript)
    - @grafema/cli   (TypeScript)
    - @grafema/mcp   (TypeScript)
    - @grafema/gui   (TypeScript)
    - rfdb-server    (Rust)
    - rfdb           (Rust)
    - js-analyzer    (Haskell)
    - python-analyzer (Haskell)
    - grafema-orchestrator (Rust)

Detected entry points: package.json#main, src/index.ts, Cargo.toml [bin]
Languages enabled: typescript, rust, haskell

Wrote .grafema/config.yaml
Updated .gitignore (added .grafema/graph.rfdb, .grafema/rfdb.sock)

Next: grafema analyze
```
