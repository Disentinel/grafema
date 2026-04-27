# tools/

Project-level Node ESM scripts that don't belong inside any `packages/*` workspace.

## regenerate-examples.mjs

Captures stdout of shell commands embedded in intent sidecars
(`_ai/intents/<category>/<name>.md`) and writes them to sibling
`<name>.captured.md` files. The renderer in
`packages/util/src/exporters/docsMd.ts` (via `intentLoader.ts`) reads those
files when expanding `{captured: <key>}` placeholders inside sidecars.

### Usage

```sh
node tools/regenerate-examples.mjs [--project <path>] [--filter <glob>] [--max-lines N]
```

Flags:

- `--project <path>` — project root (default: `cwd`). Commands run from here,
  and `_ai/intents/` is read relative to it.
- `--filter <glob>` — restrict to sidecars whose `<category>/<name>` slug
  matches the glob. Both `:` and `/` are normalized to `-`, so
  `cli:command:tldr` matches the sidecar at `_ai/intents/cli-command/tldr.md`.
- `--max-lines N` — truncate captured output to `N` lines (default: 30).
  Truncated tail is appended as `... (truncated, K more lines)`.

### Behavior

For each sidecar:

1. Parses H2 sections.
2. First sh/bash/shell fence in the section is the input command.
3. Next plain fence is inspected for a `{captured: <key>}` placeholder. If
   found, that key is used; otherwise the H2 title (slugified) is used.
4. Runs the command via `bash -c` from the project root, with a 60s timeout
   and 16 MB stdout buffer.
5. Captures stdout; appends stderr only if non-empty; filters the noisy
   `[RFDBServerBackend] Connected to ...` first stderr line.
6. On non-zero exit, prefixes output with `[exit code N]` and logs to stderr
   (does not crash the script).
7. Truncates per `--max-lines`.
8. Writes `<sidecar-stem>.captured.md` next to the sidecar with one `## <key>`
   H2 per captured section. Format matches `intentLoader.ts#parseCaptured`.

Sidecars without a sh/bash fence are skipped silently.

### Examples

Re-capture a single feature:

```sh
node tools/regenerate-examples.mjs --filter "cli:command:tldr"
```

Re-capture every CLI command sidecar with a 50-line cap:

```sh
node tools/regenerate-examples.mjs --filter "cli:command:*" --max-lines 50
```

Capture for a different checkout:

```sh
node tools/regenerate-examples.mjs --project /path/to/grafema --filter "cli:command:*"
```
