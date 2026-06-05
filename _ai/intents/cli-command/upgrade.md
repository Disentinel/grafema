---
noCapture: true
whenToUse: |
  Clean stale artifacts from ~/.grafema/bin/ and upgrade analyzer
  binaries to current version. Run after upgrading Grafema, on a
  machine with old installations, or to proactively download
  binaries for specific languages before first analysis.
seeAlso:
  - cli:command:doctor
  - cli:command:analyze
gotchas:
  - Default mode only upgrades binaries already present. Use --all
    to download every available analyzer, or --lang to pick specific
    languages.
  - Removes files not in the DOWNLOADABLE_BINARIES list (e.g.
    manually copied binaries). Use --dry-run first to preview.
---

## Clean and upgrade binaries

```sh
grafema upgrade
```

## Preview what would be cleaned/upgraded

```sh
grafema upgrade --dry-run
```

## Install specific language analyzers

```sh
grafema upgrade --lang js,python
```

## Download all available binaries

```sh
grafema upgrade --all
```

## Also clean project-level artifacts

```sh
grafema upgrade --project
```
