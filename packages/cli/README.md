# @grafema/cli

> Build a graph of your code, then query it like a database.

Grafema turns your codebase into a queryable graph: functions, calls,
dataflow, types, exports, side effects. Use it to answer structural
questions that grep can't reach: "who calls this", "where does this
value come from", "did anyone change the contract of this endpoint".

**Status: beta — APIs may shift between minor versions.**

---

## Five-minute tour

```bash
npx @grafema/cli init                              # one-time setup
npx @grafema/cli analyze                           # build the graph (1-2 min on a typical repo)
npx @grafema/cli tldr packages/cli/src/cli.ts     # 30-second file overview
npx @grafema/cli who handleRequest                # find every caller
npx @grafema/cli wtf userId                       # backward dataflow trace
```

Install globally with `npm i -g @grafema/cli` to drop the `npx` prefix.

---

## Common workflows

### "I just cloned this repo, what is it?"

```bash
grafema init                # writes .grafema/config.yaml
grafema analyze             # populates the graph
grafema overview            # node/edge counts, ISSUE summary
grafema tldr <key file>     # structural overview, 10-20× shorter than source
```

### "Where does this value come from?"

```bash
grafema wtf <symbol>            # backward dataflow
grafema trace --to <sink-spec>  # all-paths-to a sink
```

### "Who uses this function?"

```bash
grafema who <symbol>          # resolved call sites
grafema impact <node>         # downstream impact set
```

### "Why is the code structured this way?"

```bash
grafema why <symbol>          # decisions / facts in the knowledge base
```

### "Did I break anything?" (CI gate)

```bash
grafema check                 # runs every guarantee, exits non-zero on violations
grafema doctor                # local environment health check
```

### "Generate documentation from the graph"

```bash
grafema export --feature 'cli:command' --as docs-md   > cli-reference.md
grafema export --feature 'mcp:tool'    --as mcp-schema > mcp-tools.json
grafema export --feature 'http:route'  --as openapi-3.1 > openapi.yaml
```

---

## All commands

The full per-command catalogue with flags, defaults, examples, and
captured output lives in **[docs/cli-reference.md](../../docs/cli-reference.md)**.

That document is regenerated from the live graph on each release via:

```bash
grafema export --feature 'cli:command' --as docs-md --output docs/cli-reference.md
```

If you change a flag, description, or option in source, the reference
updates automatically on next build. No drift between code and docs.

---

## Notes

- All commands accept `--project <path>` to point at a specific repo.
  Defaults to the current directory.
- For AI integration via MCP, see [@grafema/mcp](../mcp/README.md).
- For VS Code integration, see [@grafema/vscode](../vscode/README.md).
- Datalog `--raw` queries fail open with a helpful warning if predicates
  are unknown — typos won't crash a script.
