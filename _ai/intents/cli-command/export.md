---
whenToUse: |
  Emit a documentation/spec artifact from the live graph. Replaces
  hand-maintained Swagger/OpenAPI/MCP-tool-registry/docs files that
  drift from reality. Pick a format with `--as` and a feature pattern
  with `--feature`. Same data → many target formats.
seeAlso:
  - cli:command:features
  - cli:command:describe
gotchas:
  - `--as openapi-3.1` only emits HTTP routes; the renderer rejects
    unsupported categories with a clear error. `--as docs-md` accepts
    everything.
  - Output files in `_ai/intents/<category>/<name>.md` add a
    "When to use" / "Examples" section to docs-md output. See
    `_ai/intents/cli-command/tldr.md` as a reference.
---

## Single-feature documentation card

```sh
grafema export --feature "cli:command:tldr" --as docs-md
```

```
{captured: export-tldr-md}
```

## Full MCP tool registry as JSON

Emits the canonical JSON-RPC tools array — the consolidated surface of
~27 advertised MCP tools (deprecated legacy names are NOT exported; they
survive only as hidden dispatch aliases).

```sh
grafema export --feature "mcp:tool" --as mcp-schema --output tools.json
```

## OpenAPI for HTTP routes

```sh
grafema export --feature "http:route" --as openapi-3.1 --output api.yaml
```
