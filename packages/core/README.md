# @grafema/core

> Core analysis engine for Grafema code analysis toolkit

**Warning: This package is in early alpha stage and is not recommended for production use.**

## Installation

```bash
npm install @grafema/core
```

## Overview

The core analysis engine that powers Grafema. It provides:

- **Orchestrator** - 5-phase analysis pipeline with parallel processing
- **Plugin system** - Extensible architecture for custom analyzers
- **Graph backend** - Abstract interface for graph storage
- **Built-in plugins** - Ready-to-use analyzers for JS/TS, React, Express, and more

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

1. **Discovery** - Find project structure and entry points
2. **Indexing** - Build module dependency graph
3. **Analysis** - Parse AST and extract entities
4. **Enrichment** - Resolve references and add edges
5. **Validation** - Check invariants and detect issues

## Built-in Plugins

### Indexing
- `JSModuleIndexer` - JavaScript/TypeScript module resolution
- `RustModuleIndexer` - Rust crate analysis

### Analysis
- `JSASTAnalyzer` - Core JS/TS AST analysis
- `ExpressAnalyzer` - Express.js routes and middleware
- `ReactAnalyzer` - React components and hooks
- `DatabaseAnalyzer` - SQL query detection
- `SocketIOAnalyzer` - WebSocket event handlers

### Enrichment
- `AliasTracker` - Transitive alias resolution
- `MethodCallResolver` - Method call binding
- `ValueDomainAnalyzer` - Value set analysis

### Validation
- `EvalBanValidator` - Detect dangerous eval usage
- `SQLInjectionValidator` - SQL injection detection
- `CallResolverValidator` - Unresolved call detection

## License

Apache-2.0
