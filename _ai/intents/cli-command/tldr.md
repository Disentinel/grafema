---
whenToUse: |
  Reading a file from scratch is slow. Use `tldr` for a 30-second
  structural overview before deciding whether to dive in. Returns
  imports, exports, calls, and key relationships in operator-shorthand
  notation — typically 10-20× shorter than the source. Especially
  useful for AI agents that have a fixed context budget and humans
  scanning unfamiliar code.
seeAlso:
  - cli:command:describe
  - cli:command:file
  - mcp:tool:get_file_overview
gotchas:
  - On unanalysed projects falls back to AST-only mode (no calls/effects).
    Run `grafema analyze` first for richer output.
  - Default depth is 1 (top-level edges). Pass `--depth 2` to expand
    nested function bodies — useful for seeing what a method actually does.
---

## Compact overview of a single command file

```sh
grafema tldr packages/cli/src/commands/doctor.ts
```

```
{captured: doctor-tldr}
```

## Drilling into nested logic

```sh
grafema tldr packages/cli/src/commands/doctor.ts --depth 2
```
