# Grafema onboarding report — ToolJet — 2026-02-07 19:46:23

## Project chosen + why
**ToolJet**. Chosen because it has a clear frontend (fetch calls) + backend (NestJS controllers) in one repo, making frontend↔backend tracing feasible without modifying Grafema itself.

## Outcome
**Success** (with local `.grafema/` customization). Total time: ~25 minutes.

## Environment
- Host: macOS arm64
- Node: v20.20.0 (via nvm)
- Grafema CLI: `@grafema/cli@0.2.4-beta`
- RFDB server: built locally and installed to `~/.local/bin/rfdb-server`

## Constraints respected
- **No changes** in `/Users/vadim/grafema`
- **Only changes** inside ToolJet `.grafema/`
- No commits in ToolJet

## What worked (happy path)
1) `npx @grafema/cli init`
2) Configure `.grafema/config.yaml` with explicit `services`, `include`, `exclude`, and disable validation.
3) Add custom analysis plugin in `.grafema/plugins` to detect NestJS routes and frontend fetch calls.
4) `npx @grafema/cli analyze --clear` completes and terminates normally.
5) `npx @grafema/cli overview` OK.
6) Graph shows `http:request`, `http:route`, `HANDLED_BY`, `INTERACTS_WITH`, `RESPONDS_WITH`, `USED_BY` edges.

## Evidence (minimum 3 queries)
**Routes**
- Command: `npx @grafema/cli ls --type http:route`
- Result: 322 routes. Example: `GET /session` from `server/src/modules/session/controller.ts`.

**Requests**
- Command: `npx @grafema/cli ls --type http:request`
- Result: 318 requests. Example: `GET /session` from `frontend/src/_services/session.service.js`.

**Request ↔ Route link**
- Command: `npx @grafema/cli get "http:request:fetch:frontend/src/_services/session.service.js:24:GET:/session"`
- Result: outgoing `INTERACTS_WITH` to `GET /session`.

**Full trace sample**
- Route node: `http:route:nest:server/src/modules/session/controller.ts:39:GET:/session`
  - Outgoing: `HANDLED_BY` → `SessionController.getSessionDetails`
  - Outgoing: `RESPONDS_WITH` → `return this.sessionService.getSessionDetails(...)`
- Response node: `http:response:nest:server/src/modules/session/controller.ts:47:SessionController.getSessionDetails`
  - Outgoing: `USED_BY` → `validateSession()` in frontend

## Workaround for analyze not terminating
- Use explicit RFDB binary + avoid `--auto-start`.
- Use `--clear` and restrict scope (services + include/exclude).
- Disable validation to avoid blocking. Analysis now finishes in ~2–3s.

**Working command:**
```
PATH="$HOME/.nvm/versions/node/v20.20.0/bin:$PATH" \
GRAFEMA_RFDB_SERVER="$HOME/.local/bin/rfdb-server" \
npx @grafema/cli analyze --clear
```

## Custom plugin (reference)
- Location: `/Users/vadim/grafema-fixtures/ToolJet/.grafema/plugins/tooljet-nest-http.mjs`
- Purpose: detect NestJS `@Controller` + `@Get/@Post/...` routes + frontend `fetch` calls; build:
  - `http:route`
  - `http:handler`
  - `http:request`
  - `http:response`
  - `http:response:usage`
  - edges `HANDLED_BY`, `INTERACTS_WITH`, `RESPONDS_WITH`, `RETURNS`, `USED_BY`

## Duplication issue (why duplicates appear)
**Observed:** duplicate edges (e.g., `CONTAINS`, `HANDLED_BY`, `INTERACTS_WITH`) for the same nodes.

**Cause:** analysis plugins are executed per indexing unit/service. ToolJet has 2 services (`frontend`, `backend`), so the plugin runs twice. Since plugin logic scans the whole project each run, it inserts the same nodes/edges twice.

**Mitigations:**
1) **Run-once guard** inside plugin: set a static/global flag so only first execution performs work.
2) **Scope by rootPrefix/service**: only scan the backend service when `context.rootPrefix === 'backend'` and frontend service when `rootPrefix === 'frontend'`.
3) **Idempotent writes**: check for existing node/edge before inserting (requires graph lookup; may be costly).
4) **Split into two plugins**: `NestRouteAnalyzer` (backend) and `FetchRequestAnalyzer` (frontend), each run in its respective service scope.

## Method matching detail
**Current behavior (prototype):**
- Request method detection is heuristic (`method: 'GET'` by default, or looks for `method: 'POST'` in nearby object literal).
- Link logic matches `request.path === route.path` and `(request.method === route.method || request.method === 'GET')`.

**Risk:**
- Over-links GET requests to non-GET routes if method detection is missing.
- Under-links when request path has params (e.g., `/users/123` vs `/users/:id`).

**Better matching approach:**
1) Parse request options object (`{ method: 'POST' }`) more reliably (AST-based or improved regex).
2) Normalize paths (replace `:param` with wildcard) and match with regex.
3) Only allow fallback `GET` when there is no explicit method AND route is GET.

## Bottlenecks (top 3)
1) No built-in NestJS route analyzer (Express analyzer yields 0 routes).
2) Missing darwin-arm64 prebuilt RFDB binary.
3) Datalog query examples return no results (graph exists, but `node(X,"TYPE")` yields empty).

## Gaps found
### Capability gaps
- NestJS route discovery.
- Datalog query mismatch with CLI `ls` results.
- Custom plugin import of `@grafema/core` fails in real projects.

### Documentation gaps
- `plugin-development.md` assumes `@grafema/core` is importable.
- No doc on ANALYSIS plugins running per service → duplicates.
- Datalog examples not matching actual query engine behavior.

## Linear issues created
- REG-379: NestJS route analyzer
- REG-380: Custom plugins can’t import `@grafema/core`
- REG-381: Datalog queries return no results for existing types
- REG-382: Missing darwin-arm64 prebuilt RFDB binary
- REG-383: Plugin docs missing idempotency guidance
- REG-378: `analyze` doesn’t terminate (previously filed)

## Action Log (condensed)
T+00:00 read Grafema docs; T+02:10 init; T+03:10 analyze failed (RFDB missing); T+05:20 built rfdb-server; T+08:20 analyze ok but no routes/requests; T+10:20 wrote custom plugin; T+11:20 analyze succeeded with routes/requests; T+12:10 verified trace chain.

## Counters
- #shell-commands: 101
- #.grafema edits: 7
- #analyze restarts: 10
- #Grafema file reads: 12
- #Target code reads: 7
- #errors/fails: 9

