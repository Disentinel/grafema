# Plugin Development Guide

> **Want to teach Grafema about your framework?** Plugins let you detect patterns specific to your codebase — custom ORMs, internal APIs, or any library Grafema doesn't support yet. A simple plugin takes 15 minutes to write.

> **Note:** This guide covers the v1 plugin API. Grafema is transitioning to core-v2, a declarative AST walker that replaces many analysis plugins. For new framework analyzers, consider using the v1 plugin system. For core language constructs, see [@grafema/core-v2](../packages/core-v2/README.md).

## Plugin Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           PIPELINE                                       │
├──────────────┬──────────────┬──────────────┬──────────────┬─────────────┤
│  DISCOVERY   │   INDEXING   │   ANALYSIS   │  ENRICHMENT  │  VALIDATION │
├──────────────┼──────────────┼──────────────┼──────────────┼─────────────┤
│ Finds        │ Builds       │ Parses AST,  │ Adds         │ Checks      │
│ services &   │ dependency   │ creates      │ semantic     │ invariants  │
│ entry points │ tree         │ nodes        │ relationships│             │
└──────────────┴──────────────┴──────────────┴──────────────┴─────────────┘
```

Each plugin:
- Inherits from `Plugin` class
- Declares metadata (phase, dependencies, created types)
- Implements `execute(context)` method
- Returns `PluginResult`

## Your First Plugin: Hello World

Let's create the simplest possible plugin — one that just logs a message and counts functions:

```javascript
import { Plugin, createSuccessResult } from '../Plugin.js';

export class HelloWorldPlugin extends Plugin {
  get metadata() {
    return {
      name: 'HelloWorldPlugin',
      phase: 'VALIDATION',  // Runs after all analysis is done
      dependencies: [],
    };
  }

  async execute(context) {
    const { graph, logger } = context;

    // Count all functions in the graph
    let count = 0;
    for await (const node of graph.queryNodes({ type: 'FUNCTION' })) {
      count++;
    }

    logger.info(`Hello from my plugin! Found ${count} functions.`);

    return createSuccessResult({ nodes: 0, edges: 0 });
  }
}
```

**That's it!** 15 lines. Add `HelloWorldPlugin` to your config and run `npx @grafema/cli analyze`.

## Plugin Types

### Discovery Plugins
**When to use:** Project has non-standard service structure.

```javascript
{
  phase: 'DISCOVERY',
  // Returns manifest with discovered services
}
```

### Indexing Plugins
**When to use:** Non-standard module system.

```javascript
{
  phase: 'INDEXING',
  creates: { nodes: ['MODULE'], edges: ['DEPENDS_ON'] }
}
```

### Analysis Plugins
**When to use:** Need to recognize patterns from a specific library.

```javascript
{
  phase: 'ANALYSIS',
  creates: { nodes: ['http:route', 'db:query'], edges: ['CONTAINS'] }
}
```

### Enrichment Plugins
**When to use:** Need to add relationships between existing nodes.

```javascript
{
  phase: 'ENRICHMENT',
  creates: { nodes: [], edges: ['CALLS', 'INSTANCE_OF'] }
}
```

### Validation Plugins
**When to use:** Need to check graph invariants.

```javascript
{
  phase: 'VALIDATION',
  // Returns warnings/errors
}
```

## Plugin Structure

```javascript
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';

export class MyLibraryAnalyzer extends Plugin {
  // 1. Plugin metadata
  get metadata() {
    return {
      name: 'MyLibraryAnalyzer',
      phase: 'ANALYSIS',           // DISCOVERY | INDEXING | ANALYSIS | ENRICHMENT | VALIDATION
      creates: {
        nodes: ['mylib:endpoint'], // Node types this plugin creates
        edges: ['HANDLES']         // Edge types this plugin creates
      },
      dependencies: ['JSASTAnalyzer']  // Plugins that must run before this one
    };
  }

  // 2. Initialization (optional)
  async initialize(context) {
    // Called once before first execute
  }

  // 3. Main logic
  async execute(context) {
    const { manifest, graph, config, logger } = context;

    try {
      // Get modules to analyze
      const modules = await this.getModules(graph);

      let nodesCreated = 0;
      let edgesCreated = 0;

      for (const module of modules) {
        // Analyze each module
        const result = await this.analyzeModule(module, graph);
        nodesCreated += result.nodes;
        edgesCreated += result.edges;
      }

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { modulesAnalyzed: modules.length }
      );

    } catch (error) {
      return createErrorResult(error);
    }
  }

  // 4. Cleanup (optional)
  async cleanup() {
    // Release resources
  }

  // 5. Helper methods
  async analyzeModule(module, graph) {
    // Analysis logic
  }
}
```

## Working with the Graph

### Creating Nodes

```javascript
await graph.addNode({
  id: `mylib:endpoint:${uniqueId}`,  // Unique ID
  type: 'mylib:endpoint',             // Node type
  name: 'GET /users',                 // Human-readable name
  file: module.file,                  // Source file
  line: node.loc.start.line,          // Line number
  column: node.loc.start.column,      // Column number
  // ... any other attributes
  method: 'GET',
  path: '/users'
});
```

### Creating Edges

```javascript
await graph.addEdge({
  type: 'HANDLES',
  src: endpointNodeId,
  dst: handlerFunctionId,
  // Optional attributes
  async: true
});
```

### Querying Nodes

```javascript
// By type
for await (const node of graph.queryNodes({ type: 'FUNCTION' })) {
  // ...
}

// By attributes
for await (const node of graph.queryNodes({ type: 'CALL', name: 'express' })) {
  // ...
}

// By ID
const node = await graph.getNode('MODULE:/src/index.js');
```

### Querying Edges

```javascript
// Outgoing edges
const edges = await graph.getOutgoingEdges(nodeId, ['CONTAINS', 'CALLS']);

// Incoming edges
const edges = await graph.getIncomingEdges(nodeId, ['CALLS']);
```

## Medium Example: Todo Detector

A plugin that finds TODO comments and creates nodes for them:

```javascript
import { readFileSync } from 'fs';
import { Plugin, createSuccessResult } from '../Plugin.js';

export class TodoDetector extends Plugin {
  get metadata() {
    return {
      name: 'TodoDetector',
      phase: 'ANALYSIS',
      dependencies: ['JSASTAnalyzer'],
      creates: { nodes: ['code:todo'], edges: ['CONTAINS'] }
    };
  }

  async execute(context) {
    const { graph, logger } = context;
    let todosFound = 0;

    // Get all modules
    for await (const module of graph.queryNodes({ type: 'MODULE' })) {
      const code = readFileSync(module.file, 'utf-8');
      const lines = code.split('\n');

      lines.forEach((line, index) => {
        const match = line.match(/\/\/\s*TODO:?\s*(.+)/i);
        if (match) {
          const todoId = `code:todo:${module.file}:${index + 1}`;

          graph.addNode({
            id: todoId,
            type: 'code:todo',
            name: match[1].trim(),
            file: module.file,
            line: index + 1,
          });

          graph.addEdge({
            type: 'CONTAINS',
            src: module.id,
            dst: todoId,
          });

          todosFound++;
        }
      });
    }

    logger.info(`Found ${todosFound} TODOs`);
    return createSuccessResult({ nodes: todosFound, edges: todosFound });
  }
}
```

## Full Example: Fastify Analyzer

A complete plugin for detecting Fastify endpoints:

```javascript
/**
 * FastifyRouteAnalyzer - detects Fastify endpoints
 *
 * Patterns:
 * - fastify.get('/path', handler)
 * - fastify.route({ method: 'GET', url: '/path', handler })
 */

import { readFileSync } from 'fs';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
const traverse = traverseModule.default || traverseModule;

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';

export class FastifyRouteAnalyzer extends Plugin {
  get metadata() {
    return {
      name: 'FastifyRouteAnalyzer',
      phase: 'ANALYSIS',
      creates: {
        nodes: ['http:route'],
        edges: ['CONTAINS', 'HANDLED_BY']
      },
      dependencies: ['JSASTAnalyzer']
    };
  }

  async execute(context) {
    const { graph, logger } = context;

    try {
      const modules = await this.getModules(graph);
      let routesCreated = 0;
      let edgesCreated = 0;

      for (const module of modules) {
        // Check if module imports fastify
        if (!await this.hasFastifyImport(module, graph)) {
          continue;
        }

        const result = await this.analyzeModule(module, graph);
        routesCreated += result.routes;
        edgesCreated += result.edges;
      }

      logger.info(`Found ${routesCreated} Fastify routes`);
      return createSuccessResult({ nodes: routesCreated, edges: edgesCreated });

    } catch (error) {
      return createErrorResult(error);
    }
  }

  async hasFastifyImport(module, graph) {
    const deps = await graph.getOutgoingEdges(module.id, ['DEPENDS_ON']);
    return deps.some(e => e.dst.includes('fastify'));
  }

  async analyzeModule(module, graph) {
    const code = readFileSync(module.file, 'utf-8');
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript']
    });

    let routes = 0;
    let edges = 0;
    const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];

    traverse(ast, {
      CallExpression: (path) => {
        const { node } = path;

        // Pattern: fastify.get('/path', handler)
        if (node.callee.type === 'MemberExpression' &&
            HTTP_METHODS.includes(node.callee.property?.name)) {

          const method = node.callee.property.name.toUpperCase();
          const pathArg = node.arguments[0];

          if (pathArg?.type === 'StringLiteral') {
            const routePath = pathArg.value;
            const routeId = `http:route:${module.file}:${node.loc.start.line}`;

            graph.addNode({
              id: routeId,
              type: 'http:route',
              name: `${method} ${routePath}`,
              method,
              path: routePath,
              file: module.file,
              line: node.loc.start.line,
              framework: 'fastify'
            });

            graph.addEdge({
              type: 'CONTAINS',
              src: module.id,
              dst: routeId
            });

            routes++;
            edges++;
          }
        }
      }
    });

    return { routes, edges };
  }
}
```

## Registering Plugins in Configuration

Plugins are registered in `.grafema/config.yaml` by class name:

```yaml
# .grafema/config.yaml

plugins:
  indexing:
    - JSModuleIndexer

  analysis:
    - JSASTAnalyzer          # Core AST analyzer (always needed)
    - ExpressRouteAnalyzer   # Built-in plugin
    - FastifyRouteAnalyzer   # Your custom plugin

  enrichment:
    - MethodCallResolver

  validation:
    - EvalBanValidator
    - HelloWorldPlugin       # Your simple plugin
```

### Plugin Order

1. Plugins execute in phase order: DISCOVERY → INDEXING → ANALYSIS → ENRICHMENT → VALIDATION
2. Within a phase, plugins are topologically sorted by `dependencies`
3. Plugins with no dependency relationship run in registration order

### Execution Model & Idempotency

ANALYSIS plugins may execute **per module/indexing unit**, not necessarily once per project. This means any global logic you run in `execute()` can be invoked multiple times, and naive node/edge creation can produce duplicates.

Recommended patterns:
- Use **deterministic IDs** for nodes and edges (for example, derived from file path + semantic identity) so re-execution naturally converges on the same graph entities.
- For truly global work, add a **run-once guard** inside the plugin instance (a boolean flag) and return early on subsequent calls.
- Prefer **file-scoped processing**: treat the current module as the unit of work rather than scanning the entire graph on each execute.
- If you must aggregate across modules, **check for existing nodes/edges** before creating new ones, keyed by stable identifiers.

### Adding a Built-in Plugin

To add a plugin to the Grafema codebase:

1. Create the file in the appropriate directory:
   ```
   packages/core/src/plugins/analysis/FastifyRouteAnalyzer.ts
   ```

2. Add export to `packages/core/src/index.ts`:
   ```typescript
   export { FastifyRouteAnalyzer } from './plugins/analysis/FastifyRouteAnalyzer.js';
   ```

3. Add to DEFAULT_CONFIG in `packages/core/src/config/ConfigLoader.ts` if it should be enabled by default.

### Custom Plugins in Project

Place custom plugins in `.grafema/plugins/` directory:

```
your-project/
├── .grafema/
│   ├── config.yaml
│   └── plugins/
│       ├── MyCustomAnalyzer.mjs    # ESM plugin
│       ├── LegacyAnalyzer.cjs      # CommonJS plugin
│       └── AnotherPlugin.js        # Auto-detected format
```

Supported extensions: `.js`, `.mjs`, `.cjs`

**ESM Plugin Example (`.mjs`):**
```javascript
// .grafema/plugins/MyAnalyzer.mjs
import { Plugin, createSuccessResult } from '@grafema/core';

export default class MyAnalyzer extends Plugin {
  get metadata() {
    return {
      name: 'MyAnalyzer',
      phase: 'ANALYSIS',
      dependencies: ['JSASTAnalyzer'],
    };
  }

  async execute(context) {
    // Your analysis logic
    return createSuccessResult({ nodes: 0, edges: 0 });
  }
}
```

#### ESM + CJS Interop

If your plugin needs to import CommonJS modules from the target project (e.g., legacy config files), use `createRequire`:

```javascript
// .grafema/plugins/LegacyConfigReader.mjs
import { createRequire } from 'module';
import { Plugin, createSuccessResult } from '@grafema/core';

export default class LegacyConfigReader extends Plugin {
  get metadata() {
    return { name: 'LegacyConfigReader', phase: 'DISCOVERY', dependencies: [] };
  }

  async execute(context) {
    const { projectPath } = context;

    // Create require function relative to project
    const require = createRequire(projectPath + '/package.json');

    // Now you can require CJS modules from the project
    const legacyConfig = require('./config/services.js');

    // Process the config...
    return createSuccessResult({ nodes: 0, edges: 0 });
  }
}
```

**Alternative: execSync pattern** for complex CJS interop:

```javascript
// .grafema/plugins/ComplexCJSIntegration.mjs
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export default class ComplexCJSIntegration extends Plugin {
  async execute(context) {
    const { projectPath } = context;

    // Create a temporary CJS script that does the heavy lifting
    const script = `
      const config = require('./config');
      const result = extractServices(config);
      console.log(JSON.stringify(result));
    `;

    const scriptPath = join(projectPath, '.grafema', '.tmp-extract.cjs');
    writeFileSync(scriptPath, script);

    try {
      const output = execSync(\`node \${scriptPath}\`, { cwd: projectPath });
      const services = JSON.parse(output.toString());
      // Process services...
    } finally {
      unlinkSync(scriptPath);
    }

    return createSuccessResult({ nodes: 0, edges: 0 });
  }
}
```

## Type Naming Conventions

| Category | Format | Examples |
|----------|--------|----------|
| Framework-specific | `framework:type` | `http:route`, `socketio:emit`, `db:query` |
| Generic | `UPPERCASE` | `MODULE`, `FUNCTION`, `CALL`, `VARIABLE` |
| Edges | `UPPERCASE` | `CONTAINS`, `CALLS`, `DEPENDS_ON` |

### Existing Node Types

- `MODULE`, `FUNCTION`, `CLASS`, `METHOD`, `VARIABLE`, `PARAMETER`
- `CALL`, `METHOD_CALL`, `EXPRESSION`
- `http:route`, `http:request`, `http:api`
- `db:query`, `db:table`
- `socketio:emit`, `socketio:on`
- `react:component`, `react:hook`
- `GUARANTEE`

### Existing Edge Types

- `CONTAINS`, `CALLS`, `DEPENDS_ON`
- `ASSIGNED_FROM`, `DERIVES_FROM`
- `INSTANCE_OF`, `PASSES_ARGUMENT`, `HAS_PARAMETER`
- `USES_MIDDLEWARE`, `HANDLED_BY`
- `GOVERNS`, `VIOLATES`

## Testing Your Plugin

### Unit Test Structure

```javascript
// test/unit/FastifyRouteAnalyzer.test.js
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = 'test/fixtures/fastify-app';

describe('FastifyRouteAnalyzer', () => {
  let client, cleanup;

  beforeEach(async () => {
    ({ client, cleanup } = await createTestDatabase());
  });

  after(async () => {
    await cleanup();
  });

  it('should detect fastify routes', async () => {
    const orchestrator = createTestOrchestrator(client);
    await orchestrator.run(FIXTURE_PATH);

    // Verify routes were found
    const routes = [];
    for await (const node of client.queryNodes({ type: 'http:route' })) {
      if (node.framework === 'fastify') {
        routes.push(node);
      }
    }

    assert.ok(routes.length > 0, 'Should find fastify routes');
  });
});
```

### Test Fixture

```javascript
// test/fixtures/fastify-app/index.js
import Fastify from 'fastify';

const fastify = Fastify();

fastify.get('/users', async (request, reply) => {
  return { users: [] };
});

fastify.post('/users', async (request, reply) => {
  return { created: true };
});

export default fastify;
```

**Expected output:**
- 2 `http:route` nodes: `GET /users` and `POST /users`
- 2 `CONTAINS` edges from the MODULE to each route

## Debugging

### Logging

Use `context.logger` instead of `console.log`:

```javascript
async execute(context) {
  const { logger } = context;

  logger.info(`Processing ${modules.length} modules...`);
  logger.debug(`Found pattern at ${file}:${line}`);
}
```

Control log level via CLI:
```bash
npx @grafema/cli analyze --log-level debug
```

### Common Problems

| Problem | Solution |
|---------|----------|
| Plugin doesn't find patterns | Add `logger.debug(JSON.stringify(node, null, 2))` in traverse to see AST |
| Nodes created but not visible | Check ID uniqueness |
| Edges not created | Verify src and dst nodes exist |
| Plugin runs too early | Add missing `dependencies` to ensure correct order |
| Plugin doesn't run at all | Verify class name is in config.yaml |

## Plugin Development Checklist

- [ ] Plugin type determined (analysis/enrichment/validation)
- [ ] Metadata correct (phase, dependencies, creates)
- [ ] Execute returns PluginResult
- [ ] Nodes have unique IDs
- [ ] Nodes have file/line for navigation
- [ ] Edges connect existing nodes
- [ ] Tests written with fixture
- [ ] Plugin added to config.yaml

## See Also

- [Configuration Reference](configuration.md) — Full configuration reference
- [Project Onboarding](project-onboarding.md) — Getting started with Grafema
- [Glossary](glossary.md) — Term definitions
