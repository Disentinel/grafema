---
noCapture: true
whenToUse: |
  Health check before you start debugging. Reports: which analyzer
  binaries are present (or downloadable), config file validity, RFDB
  server reachability, schema version compatibility. Run when
  `analyze` fails mysteriously or after upgrading Grafema.
seeAlso:
  - cli:command:analyze
  - cli:command:overview
gotchas:
  - On a fresh install some analyzers download lazily on first
    `analyze` — `doctor` shows them as "downloadable", not missing.
    That's fine.
---

## Local environment health

```sh
grafema doctor
```

```
{captured: doctor-output}
```
