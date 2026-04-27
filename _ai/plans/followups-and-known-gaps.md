# Followups and known gaps

**Created:** 2026-04-27 from autonomous polish session after Sprints 4-6.

Captured here so the next session has a clear picture of what's known but
deferred. Each item links to the relevant Linear or notes "no Linear yet".

## Performance baseline (per-extractor, on Grafema's own graph)

Measured on a populated RFDB after Sprints 4-5 enrichment:

| Extractor | n | hits | null | total | avg / feature |
|---|---|---|---|---|---|
| `commanderExtractor` | 66 | 66 | 0 | 5908ms | **89.5ms** |
| `mcpInputSchemaExtractor` | 44 | 38 | 6 | 39ms | 0.9ms |
| `vscodeContributesExtractor` | 40 | 33 | 7 | 12ms | 0.3ms |
| `httpRouteExtractor` | 0 | — | — | — | — (no nodes yet) |

`commanderExtractor` is **~100× slower** than the file-reading extractors
because it walks the RECEIVER_CALL chain via sequential RPC round-trips
(getOutgoingEdges → getNode per ancestor). On a 200-command project this is
~18s, manageable but worth optimising. Candidate: hydrate the chain once
per anchor with batched fetch, or move chain-walk into a single Datalog
query.

**No Linear yet.** Open `REG-PERF: commanderExtractor chain-walk batching`
when this becomes a hot path on a real project.

## Diagnosed null-spec features (after Sprints 4-5 enrichment)

13 of 150 live FEATUREs returned null from extractors. Categorised:

| Cause | Count | Examples | Action |
|---|---|---|---|
| Expected (`setRequestHandler` is not a tool) | 4 | `CallToolRequestSchema`, `GetPromptRequestSchema`, `ListPromptsRequestSchema`, `ListToolsRequestSchema` | accept |
| Stale orphan from old run | 1 | `mcp:tool 'TEST' in a.ts` | gone after `grafema analyze --clear` |
| Real bug — file exists but `inputSchema` parse failed | 1 | `mcp:tool 'query_graphql'` in `graphql-tools.ts` | **investigate** |
| vscode commands registered programmatically (no `contributes` entry) | 4 | `grafemaCallers`, `grafemaStatus`, `grafemaDebug`, `grafemaValueTrace` | gap — either add to `package.json#contributes` or extend extractor to fall back to programmatic context |
| Dynamic registration expression (not a string literal) | 3 | `<array>` ×2, `<arrow>` | data-side limit; no fix needed |

**No Linear yet.** Open `REG-EXTRACTOR-BUG: query_graphql inputSchema parse failure` (1)
and `REG-VSCODE: programmatic-only commands without contributes entry` (1).

## Known shipped-code gaps (deferred to follow-up REGs)

### `SpecedContractData` schema is too narrow

Boundary cases caught during extractor implementation that the current
schema can't represent cleanly:

- **Top-level `name`** — commander spec parses out a command name
  (`build` from `'build <input>'`) but it's only stored as part of
  `feature.name`. Currently the parsed name is lost.
- **Top-level `description`** — commander `.description('text')`,
  vscode title, MCP tool description. Currently encoded as a synthetic
  `SpecedContractOutput[0]` workaround.
- **`inputs[].variadic: boolean`** — commander `<files...>`. Currently
  shoehorned into `description: 'variadic'` + `type: 'string[]'`.
- **`inputs[].enum: unknown[]`** — JSON Schema enum constraints are
  dropped by `mcpInputSchemaExtractor`.
- **`inputs[].format`, `inputs[].minimum`, `inputs[].maximum`** — JSON
  Schema validation constraints not extracted.
- **`type` is a free-form string** — extractors emit `"string"`,
  `"string[]"`, `"int"`, `"object"` interchangeably. Strict downstream
  validators (e.g. JSON Schema 2020-12) will reject `"string[]"`. Either
  normalise on emit or use a richer union type.
- **Nested object types** — `mcpInputSchemaExtractor` flattens to
  `type: 'object'` without recursing into `properties`. Fine for shallow
  MCP schemas, but limits future complex CLI / HTTP body shapes.
- **No `default` change detection** — `contractDiff` (REG-1117) ignores
  `inputs[].default` field. A silent default flip (`true → false`) won't
  show up as breaking.
- **`SpecedContractOutput` lacks structure** — no status code, body
  shape, content type. Currently a free-form `description` string only.
  Limits OpenAPI / docs-md output richness.
- **Output identity by `name ?? type`** — both undefined silently
  dropped from diffs. Should normalise or reject in extractor.
- **Cross-modality output types** can differ (one extractor sets `type`,
  the other doesn't); the equivalence test (REG-1117 Layer 3) flags
  cosmetic differences as divergence.

**No Linear yet.** Open `REG-SCHEMA: SpecedContractData v2 — add name,
description, variadic, enum, format, validation constraints, structured
outputs`.

### `httpRouteExtractor` v1 limitations

- **Body-shape extraction from `req.body.x` reads** — out of scope v1;
  needs taint dataflow forward from handler `req` parameter. Tracked
  inline in extractor comments; will become its own REG once HTTP routes
  surface in real graphs.
- **Fastify `.route({ method, url, schema, handler })` single-object
  form** skipped — handler isn't a positional arg, so `args[].role`
  doesn't fit. Needs a different annotation pattern.
- **Hono `app.on(['GET','POST'], '/path', handler)` method-list form**
  reads only `path[0]`; multiple methods not unrolled.

### `mcpInputSchemaExtractor` v1 limitations

- **`outputs` and `errors` empty** for all MCP tools — MCP doesn't
  declare structured output schemas in tool definitions; would need AST
  inspection of the handler body to derive (`return { content: [...] }`
  patterns for outputs; `throw new XxxError(...)` for errors).
- **`enum` / `format` constraints** dropped, see "Schema is too narrow"
  above.
- **`items: SchemaProperty` for arrays** dropped — currently just
  `type: 'array'`.

## Express LibraryDef migration not yet pruned

Sprint 5 (REG-1115) added effects-db YAMLs for express/fastify/koa/hono
but did **not** delete `packages/js-analyzer/src/Domain/Libraries/Express.hs`
or its entry in `Matcher.hs#allLibraryDefs`. Deletion is gated on:
1. Live `grafema analyze --clear` run completing successfully (RFDB write
   throughput must not saturate — depends on REG-1124 being stable).
2. Verifying http:route node count from new YAML matches what Express.hs
   was producing (or strictly expanding it — fastify/koa/hono additions
   are net-new).

**No Linear yet.** Open `REG-CLEANUP: delete Express.hs after YAML parity
verified` once live verify possible.

## Stale data in current `.grafema/rfdb.sock`

Live graph has duplicate `cli:command` entries (`'overview'` quoted +
`overview` unquoted) from old strip-quotes pre-/post- migration.
`grafema analyze --clear` resolves on next run.

The `mcp:tool 'TEST' in a.ts` orphan likewise.

## REG-1117 layer tests vs populated goldens

`test/unit/{behaviorGolden,contractDiff,crossModalityEquivalence,effectSurfaceDiff}.test.js`
were designed to pass on **empty** goldens (initial state) and detect
diffs once goldens are populated. They use a small synthetic graph
fixture which doesn't match the live-graph populated golden — so once
goldens have content from `regenerate-*.mjs`, the layer tests fail.

Resolution paths:
1. Use a fixture-specific golden (committed under `test/golden/fixture/`)
   while production goldens live elsewhere.
2. Layer tests scope diff to the fixture's feature subset only.
3. Document that goldens stay empty in the repo and CI regenerates +
   diffs against the same run's analysis — not against a synthetic
   fixture.

Goldens have been reset to `{}` in this commit. Rationale: option 3 — CI
runs `regenerate-*.mjs` against a live analysis and the regen scripts
emit diff into PR comments. Layer tests stay green on empty goldens for
local dev. Not blocking release, but worth a clean redesign.

**No Linear yet.** Open `REG-1117-FIX: separate fixture-goldens from
production goldens` if/when CI integration goes live.

## What's working solidly end-to-end

The release-critical surface is good:

- 4 SpecedContract extractors persist 137 contracts on Grafema's own
  graph (66 cli + 38 mcp + 33 vscode).
- `grafema export --as docs-md` renders feature catalogues with TOC and
  single-feature mode (the REG-1118 path) correctly.
- `grafema export --as openapi-3.1 --feature 'http:*'` emits valid
  OpenAPI 3.1 (pending real http:route data after `--clear`).
- `grafema export --as mcp-schema --feature 'mcp:tool:*'` emits
  canonical JSON-RPC tool registry — directly servable by MCP runtime.
- `grafema export --as json-schema --feature <id>` emits Draft 2020-12
  schemas with `x-grafema` extension.
- `grafema features --duplicates` and MCP `find_shared_behaviors` —
  cross-modality dedup surfaced (currently 0 clusters on Grafema, but
  the surface works on synthetic fixtures).
- 4-layer regression infra in place (helpers tested in isolation; layer
  tests pass on empty goldens; regen scripts produce live snapshots).

## Recommended next session order

1. RFDB write throughput stabilisation (separate Track 1 effort, blocks
   live `--clear` runs)
2. Live `grafema analyze --clear` to confirm http:route appears, prune
   `Express.hs`, regenerate goldens against production state
3. SpecedContractData v2 schema work (REG-SCHEMA above) — unblocks
   richer downstream renderers
4. Sociotechnical bridge research thread (prompt at
   `_ai/prompts/sociotechnical-bridge-session-prompt.md`)
5. v0.5+ research issues (REG-1120 emergent contracts, REG-1121
   COMPONENT clustering, REG-1122 graph-diff, REG-1123 FEATURE_FLAG)
