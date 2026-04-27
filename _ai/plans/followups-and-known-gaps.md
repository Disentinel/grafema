# Followups and known gaps

**Created:** 2026-04-27 after Sprints 4-6 + autonomous polish round.
**Last updated:** 2026-04-27 after second polish round.

Captured here so the next session has a clear picture of what's known but
deferred. Each item links to the relevant Linear or notes "no Linear yet".

## Resolved in second polish round (2026-04-27)

- ✅ **RFDB write-throughput** — probed live (10/500/5000-node + 5000-edge writes,
  read 5510 nodes). Healthy: 19k nodes/s write, 54k edges/s, 54k nodes/s read.
  PR #258 (RFD-67) clearly fixed the write-storm issue. Local task closed.
- ✅ **`query_graphql` extractor null bug** — diagnosed root cause:
  `type: 'object' as const` TypeScript suffix made `new Function()` throw.
  Fixed via `stripTypeAssertions()` helper in `mcpInputSchemaExtractor.ts`.
  3 regression tests added.
- ✅ **vscode programmatic-only commands** (`grafemaCallers`, `grafemaStatus`,
  `grafemaDebug`, `grafemaValueTrace`) — extended `vscodeContributesExtractor`
  to fall back to `contributes.views.<container>[]` lookup when `commands[]`
  doesn't match. They render as `view: <name> | container: <id> |
  visibility: <state>` instead of "No speced contract recovered".
- ✅ **SpecedContractData v2 schema** — added top-level `name`, `description`,
  `inputs[].variadic`, `inputs[].enum`, `inputs[].format`, `inputs[].minimum`,
  `inputs[].maximum`, `inputs[].minLength`, `inputs[].maxLength`,
  `inputs[].pattern`, `outputs[].statusCode`, `outputs[].kind`,
  `errors[].statusCode`. All 4 extractors populate; all 4 renderers surface;
  `contractDiff` v2 reports `default`/`enum`/`format` changes as `[NOTE]`
  severity. Live: `mcp:tool find_nodes` now has full description, every
  property carries `description`, `mcp-schema` renderer emits servable JSON.
- ✅ **REG-1117 fixture-vs-production goldens** — split into two-tier:
  `test/golden/fixture/*.json` committed (validated by layer tests), plus
  separate `test/golden/regenerate-fixture-goldens.mjs` regen script.
  Production goldens (`test/golden/*.json`) stay `{}` and are populated
  on-demand by CI / live regen scripts. Layer tests now always assert
  zero diff against fixture goldens (no skip-when-empty branch).

## Live state on Grafema (after polish round)

- 142 SPECED_CONTRACTs persisted (from 137 before polish — +5: 4 vscode views,
  1 query_graphql)
- `featuresWithoutSpec`: **8** (down from 13). Composition:
  - 4 expected (`setRequestHandler` features — not tools)
  - 1 stale orphan (`mcp:tool 'TEST' in a.ts` — disappears on `--clear`)
  - 3 dynamic registrations (`<array>` ×2, `<arrow>`) — data-side limit
- All real bugs cleared.

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

## Known shipped-code gaps (deferred to follow-up REGs)

### `libraryCallbackEnricher` mis-categorises view providers as `vscode:command`

`vscode.window.registerTreeDataProvider`, `registerWebviewViewProvider`,
`registerWebviewPanelSerializer`, `registerCustomEditorProvider` all map to
`vscode:command` in `LIBRARY_NODE_TYPE`. They're conceptually different
entities (TreeView, WebviewView, WebviewPanel, CustomEditor — not commands).
The polish round added a view-fallback in `vscodeContributesExtractor` to
recover *something* for these features, but the L0 categorisation is still
wrong. Proper fix: introduce per-method overrides in
`LIBRARY_NODE_TYPE` (or a `node_type` field per CALL signature in
effects-db YAML) to emit `vscode:treeView` / `vscode:webviewView` /
`vscode:editor` distinctly. Will need new categories in
`FEATURE_TYPES` across `specedContractEnricher`, `behaviorEnricher`,
`contractEnricher`.

**No Linear yet.** Open `REG-VSCODE-CATEGORIES: split vscode entity types
beyond vscode:command`.

### `SpecedContractData` schema v3 (after v2 lands)

v2 (shipped this round) closed: top-level name/description, variadic,
enum, format, min/max length, pattern, statusCode skeleton, output kind.
Remaining for a future v3:

- **`type` is a free-form string** — extractors emit `"string"`,
  `"string[]"`, `"int"`, `"object"` interchangeably. Strict downstream
  validators (JSON Schema 2020-12) will reject `"string[]"`. Either
  normalise on emit or use a richer union type.
- **Nested object types** — `mcpInputSchemaExtractor` flattens nested
  inputSchema properties to `type: 'object'` without recursion. Limits
  rich JSON-Schema use cases.
- **`statusCode` populated by no extractor** — schema has the field but
  populating it requires handler-body taint dataflow (out of scope of
  the basic extractors). Future `httpRouteExtractor` v2 with body-shape
  inference would close this.
- **Output identity by `name ?? type`** — `kind` not part of equivalence
  key. Cosmetic kind flip on unnamed outputs won't be flagged in diff.

**No Linear yet.** Open `REG-SCHEMA-V3: type normalisation + nested
recursion + statusCode population`.

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
- ~~`enum` / `format` constraints~~ — RESOLVED in v2.
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

## What's working solidly end-to-end (post-polish)

- **142 SpecedContracts** on Grafema's own graph (66 cli + 39 mcp + 37
  vscode). Only 8 remaining nulls — all expected (4 setRequestHandler,
  1 stale orphan, 3 dynamic).
- `grafema export --as docs-md` renders feature catalogues with full
  descriptions, variadic markers, allowed-values lines.
- `grafema export --as openapi-3.1 --feature 'http:*'` will emit OpenAPI
  3.1 with enum/format/min/max/pattern (pending real http:route data
  after `--clear`).
- `grafema export --as mcp-schema --feature 'mcp:tool:*'` emits
  canonical JSON-RPC tool registry with full descriptions and validation
  constraints — directly servable by MCP runtime.
- `grafema export --as json-schema --feature <id>` emits Draft 2020-12
  schemas with `x-grafema` extension and full validation constraints.
- `grafema features --duplicates` and MCP `find_shared_behaviors` —
  cross-modality dedup surfaced (currently 0 clusters on Grafema).
- 4-layer regression infra: production-goldens (`{}` in repo) +
  fixture-goldens (committed, validated by layer tests).

## Recommended next session order

1. Live `grafema analyze --clear` end-to-end on Grafema. Verify
   http:route appears (Sprint 5 YAMLs do their job). Prune
   `Express.hs` once parity confirmed.
2. `commanderExtractor` chain-walk batching (perf — 89ms/feature)
3. `vscode:command` category split (REG-VSCODE-CATEGORIES) — separate
   TreeView / WebviewView entity types in libraryCallbackEnricher
4. SpecedContractData v3 schema work (REG-SCHEMA-V3) — type
   normalisation + nested object recursion + statusCode population
5. Sociotechnical bridge research thread (prompt at
   `_ai/prompts/sociotechnical-bridge-session-prompt.md`)
6. v0.5+ research issues (REG-1120 emergent contracts, REG-1121
   COMPONENT clustering, REG-1122 graph-diff, REG-1123 FEATURE_FLAG)
