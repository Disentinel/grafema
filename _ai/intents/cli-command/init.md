---
noCapture: true
whenToUse: |
  First command in a Grafema project. `init` scans the repo, detects
  language(s) and entry points, and writes `.grafema/config.yaml` with
  sensible defaults. Run once per project; afterwards just `analyze`.
  For zero-config flow, skip and use `grafema analyze --quickstart`
  which auto-init's on first run.
seeAlso:
  - cli:command:analyze
  - cli:command:doctor
gotchas:
  - Won't overwrite an existing `.grafema/config.yaml`. Delete or
    rename it first if you want to re-run from scratch.
---

## Initialize a project

```sh
grafema init
```

```
{captured: init-output}
```
