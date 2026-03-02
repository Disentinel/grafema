# User Request: REG-591

**Linear:** https://linear.app/grafemadev/issue/REG-591/core-v2-plugin-api-for-domain-analyzers-express-react-db-socketio

## Goal

v1 has 10 domain-specific analyzers (Express, NestJS, React, Socket.IO, DB, Fetch, Rust, ServiceLayer) baked into the analysis phase (~3,500 lines). v2 needs a plugin API so these can be implemented as separate modules.

## Domain analyzers to port

| Analyzer | What it detects | Priority |
|----------|----------------|----------|
| ExpressAnalyzer + RouteAnalyzer | Express routes, middleware | High |
| FetchAnalyzer | HTTP requests (fetch, axios) | High |
| ReactAnalyzer | React components, hooks | Medium |
| SocketIOAnalyzer | Socket.IO events | Medium |
| DatabaseAnalyzer + SQLite | DB queries | Medium |
| NestJSRouteAnalyzer | NestJS routes | Low |
| RustAnalyzer | Rust FFI | Low |

## Approach

1. Define `VisitorPlugin` interface: receives visitor results, can add extra nodes/edges
2. Plugin registration in walk.ts via registry
3. Port ExpressAnalyzer first as reference implementation

## Acceptance criteria

* Plugin API defined and documented
* At least one domain analyzer (Express) ported to v2 plugin API
* v1 domain analyzers can coexist with v2 plugins during transition

## MLA Configuration

Full MLA — core architecture change affecting analysis pipeline.
