# AGENTS.md

<INSTRUCTIONS>
- On session start, read and follow `/Users/vadim/grafema/CLAUDE.md`.
- If `CLAUDE.md` changes during the session, re-read it and adjust behavior.
</INSTRUCTIONS>

## Fixtures (for onboarding tests)

Local clones of large OSS JS/TS projects live outside this repo at:

- `/Users/vadim/grafema-fixtures/`
  - `/Users/vadim/grafema-fixtures/ToolJet` (branch `develop`)
  - `/Users/vadim/grafema-fixtures/directus` (branch `main`)
  - `/Users/vadim/grafema-fixtures/n8n` (branch `master`)
  - `/Users/vadim/grafema-fixtures/cal.com` (branch `main`)
  - `/Users/vadim/grafema-fixtures/strapi` (branch `main`)

What to do with them:

- Treat as disposable test data (never commit into Grafema repo).
- Run Grafema onboarding against them from within each project directory:
  - `npx @grafema/cli init`
  - `npx @grafema/cli analyze`
  - `npx @grafema/cli overview`
- Prefer adding per-project `.grafema/config.yaml` using `services:` for monorepos.

Known nuance:

- `ToolJet` clone produced a case-collision warning on macOS (two paths differ only by letter case); working tree keeps only one of the colliding files. This is useful to test robustness on case-insensitive filesystems.
