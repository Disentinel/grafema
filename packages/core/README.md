# @grafema/core

> Core analysis engine for Grafema code analysis toolkit

**Warning: This package is in beta stage and the API may change between minor versions.**

## Installation

```bash
npm install @grafema/core
```

## Overview

The core analysis engine that powers Grafema. It provides:

- **Orchestrator** — 5-phase analysis pipeline with parallel processing
- **Plugin system** — Extensible architecture with declarative dependencies and topological ordering
- **Graph backend** — Abstract interface for graph storage (RFDB or in-memory)
- **33 built-in plugins** — Ready-to-use analyzers for JS/TS, React, Express, and more

## Quick Start

```typescript
import { Orchestrator, RFDBServerBackend } from '@grafema/core';

const orchestrator = new Orchestrator({
  rootDir: './src',
  backend: new RFDBServerBackend({ socketPath: '/tmp/rfdb.sock' }),
  workers: 4
});

await orchestrator.initialize();
await orchestrator.run();

const stats = orchestrator.getStats();
console.log(`Analyzed ${stats.filesProcessed} files`);
```

## Analysis Pipeline

The orchestrator runs analysis in 5 phases:

1. **Discovery** — Find project structure, workspaces, and entry points
2. **Indexing** — Build module dependency graph
3. **Analysis** — Parse AST and extract entities (parallel across files)
4. **Enrichment** — Resolve cross-file references and add edges
5. **Validation** — Check invariants and detect issues

## Built-in Plugins

### Discovery
- `WorkspaceDiscovery` — npm/pnpm/yarn/lerna workspace detection
- `MonorepoServiceDiscovery` — Monorepo service discovery

### Indexing
- `JSModuleIndexer` — JavaScript/TypeScript module resolution
- `RustModuleIndexer` — Rust crate analysis

### Analysis
- `JSASTAnalyzer` — Core JS/TS AST analysis
- `ExpressRouteAnalyzer` — Express.js routes and middleware
- `ExpressResponseAnalyzer` — Express.js response tracking
- `NestJSRouteAnalyzer` — NestJS controller routes
- `ReactAnalyzer` — React components and hooks
- `DatabaseAnalyzer` — SQL query detection
- `FetchAnalyzer` — HTTP fetch/axios call tracking
- `SocketIOAnalyzer` — WebSocket event handlers
- `ServiceLayerAnalyzer` — Service layer pattern detection

### Enrichment
- `MethodCallResolver` — Method call binding
- `ArgumentParameterLinker` — Argument-to-parameter binding
- `AliasTracker` — Transitive alias resolution
- `ImportExportLinker` — Cross-file import resolution
- `ValueDomainAnalyzer` — Value set analysis
- `MountPointResolver` — Express router mount prefix resolution
- `ClosureCaptureEnricher` — Closure variable capture
- `ServiceConnectionEnricher` — Cross-service connection discovery

### Validation
- `EvalBanValidator` — Detect dangerous eval usage
- `SQLInjectionValidator` — SQL injection detection
- `CallResolverValidator` — Unresolved call detection
- `BrokenImportValidator` — Broken import detection
- `PackageCoverageValidator` — npm package analyzer coverage tracking
- `ShadowingDetector` — Variable shadowing detection
- `AwaitInLoopValidator` — Await-in-loop performance issues

## Extending

Create custom plugins by implementing the plugin interface:

```typescript
import { AnalysisPlugin } from '@grafema/core';

class MyPlugin extends AnalysisPlugin {
  static metadata = {
    name: 'my-plugin',
    phase: 'ANALYSIS',
    creates: ['MY_NODE_TYPE'],
    dependencies: ['JSASTAnalyzer'],
  };

  async analyze(file, context) {
    // Your analysis logic
  }
}
```

## License

Apache-2.0
