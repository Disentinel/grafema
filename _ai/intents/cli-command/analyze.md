---
noCapture: true
whenToUse: |
  Builds (or rebuilds) the code graph. Run after a fresh `init`, after
  major refactors, or when you `git pull` significant changes. For
  incremental updates, `analyze` reuses cached parser output where
  possible. Pass `--clear` to drop all existing data and rebuild from
  scratch — useful when extractor logic changes upstream.
seeAlso:
  - cli:command:init
  - cli:command:resolve
  - cli:command:overview
gotchas:
  - Long-running on first run (~1 min per 1k files for JS/TS).
    Subsequent runs use the resolver cache and are dramatically
    faster.
  - The Rust orchestrator must be installable for the host platform —
    `grafema doctor` confirms this.
---

## Full analysis

```sh
grafema analyze
```

```
{captured: analyze-output}
```

## Force rebuild (drops cache)

```sh
grafema analyze --clear
```
