# REG-363: USG Phase 1 — Implementation Plan

**Date:** 2026-02-15
**Author:** Don Melton (Tech Lead)
**Workflow:** v2.1

## Research Summary

I researched existing approaches to infrastructure plugin frameworks and multi-layer graph modeling:

### Backstage Architecture (Industry Standard)
Backstage uses a **plugin-architecture** for developer portals with three plugin types: standalone, service-backed, and third-party backed ([Backstage Architecture Overview](https://backstage.io/docs/overview/architecture-overview/)). Their catalog graph uses **entities as nodes** with **kinds** for broad categorization (service, database, team). This aligns with our `layer:tool:resource` convention.

**Key insight:** Infrastructure-automation plugins emerge because organizations need to enforce compliance, standardize IaC, and span lifecycle from code generation to runtime management ([Top Backstage Plugins 2026](https://stackgen.com/blog/top-backstage-plugins-for-infrastructure-automation-2026-edition)).

### IaC Static Analysis Patterns
Static analysis of IaC involves ([Static Analysis of Infrastructure as Code Survey](https://arxiv.org/pdf/2206.10344)):
1. **Parsing** — read IaC configuration files
2. **Static analysis and policy evaluation** — compare against security policies, best practices, compliance frameworks (CIS, NIST, GDPR, HIPAA)
3. **Plugin extensibility** — TFLint provides plugin-extensible framework for Terraform ([IaC Scanning Tools](https://spacelift.io/blog/iac-scanning-tools))

**Key insight:** IaC analyzers follow a structured lifecycle: discover files → parse → validate/link. This is exactly what our `InfraAnalyzer` does.

### Multi-Layer Graph Cross-Layer Linking
Multi-layer graphs distinguish between ([Multilayer Networks](https://academic.oup.com/comnet/article/2/3/203/2841130)):
- **Intra-layer edges** — connections within a layer (solid lines)
- **Inter-layer edges** — cross-layer connections (dotted lines)

Analysis tools like MuxViz and gCore ([gCore Paper](https://www.vldb.org/pvldb/vol16/p3201-zou.pdf)) use **low coupling** to favor clusters within layers, **high coupling** for cross-layer clusters.

**Key insight:** Our cross-layer edges (DEPLOYED_TO, PROVISIONS, etc.) are **inter-layer edges**. The linking strategy (plugin-based, no heuristics) avoids the over-coupling problem found in heuristic-based systems.

### Architecture Validation
Our approach is **validated by industry patterns**:
1. ✅ Plugin-based extensibility (Backstage, TFLint)
2. ✅ Structured lifecycle: discover → parse → link (IaC static analysis)
3. ✅ Clear separation of intra-layer vs inter-layer edges (multi-layer graph theory)
4. ✅ No heuristics — developers write analyzers for their projects (Backstage philosophy)

---

## Implementation Plan

### Overview
This task creates the **base framework** for infrastructure analysis plugins. No reference implementations — those come in Phase 2 (REG-364 for K8s).

**Estimated effort:** 2-3 days (framework only)

### Phase 1: Type Definitions (0.5 day)

#### 1.1 Edge Types (`packages/types/src/edges.ts`)
**Location:** After line 103 (after existing edge types, before `export type EdgeType`)

Add 16 cross-layer edge types to `EDGE_TYPE` constant:

```typescript
// === CROSS-LAYER EDGES (USG) ===
// Code <-> Infrastructure
DEPLOYED_TO: 'DEPLOYED_TO',
CONFIGURED_BY: 'CONFIGURED_BY',
USES_SECRET: 'USES_SECRET',
EXPOSED_VIA: 'EXPOSED_VIA',
SCHEDULED_BY: 'SCHEDULED_BY',

// Infrastructure <-> Cloud
PROVISIONS: 'PROVISIONS',
TARGETS: 'TARGETS',

// Code <-> Cloud
PUBLISHES_TO: 'PUBLISHES_TO',
SUBSCRIBES_TO: 'SUBSCRIBES_TO',
STORES_IN: 'STORES_IN',
// READS_FROM: 'READS_FROM', // Already exists (line 58)
// WRITES_TO: 'WRITES_TO',   // Already exists (line 59)
INVOKES_FUNCTION: 'INVOKES_FUNCTION',

// Any <-> Observability
MONITORED_BY: 'MONITORED_BY',
MEASURED_BY: 'MEASURED_BY',
VISUALIZED_IN: 'VISUALIZED_IN',
LOGS_TO: 'LOGS_TO',
```

**Note:** `READS_FROM` and `WRITES_TO` already exist (lines 58-59). Don't duplicate.

**Testing:** No new tests needed — these are just string constants.

---

#### 1.2 Infrastructure Types (`packages/types/src/infrastructure.ts` — NEW FILE)

Create new file for infrastructure-specific types:

```typescript
/**
 * Infrastructure Analysis Types — USG Phase 1
 * Types for infrastructure plugin framework
 */

import type { PluginContext, NodeRecord } from './plugins.js';
import type { EdgeType } from './edges.js';

/**
 * Infrastructure resource parsed from a file
 * Generic representation before graph node creation
 */
export interface InfraResource {
  /** Resource identifier (e.g., deployment name, service name) */
  id: string;

  /** Resource type (e.g., 'infra:k8s:deployment', 'cloud:aws:lambda') */
  type: string;

  /** Human-readable name */
  name: string;

  /** File where resource was defined */
  file: string;

  /** Line number in file (if available) */
  line?: number;

  /** Environment(s) this resource belongs to (undefined = all) */
  env?: string | string[];

  /** Raw resource data for analyzer-specific fields */
  metadata?: Record<string, unknown>;
}

/**
 * Cross-layer link between infrastructure and code
 */
export interface CrossLayerLink {
  /** Edge type (e.g., 'DEPLOYED_TO', 'CONFIGURED_BY') */
  type: EdgeType;

  /** Source node ID (typically code node) */
  src: string;

  /** Destination node ID (typically infra/cloud/obs node) */
  dst: string;

  /** Optional edge metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Infrastructure configuration schema
 * Top-level 'infrastructure' section in grafema.config.yaml
 */
export interface InfrastructureConfig {
  /** Enable infrastructure analysis */
  enabled: boolean;

  /** Kubernetes configuration */
  kubernetes?: K8sConfig;

  /** Terraform configuration */
  terraform?: TerraformConfig;

  /** Docker Compose configuration */
  dockerCompose?: DockerComposeConfig;

  /** Custom analyzer path */
  custom?: CustomAnalyzerConfig;
}

export interface K8sConfig {
  enabled: boolean;
  paths: string[];
  mappings?: K8sMapping[];
}

export interface K8sMapping {
  deployment: string;
  service: string;
}

export interface TerraformConfig {
  enabled: boolean;
  paths: string[];
}

export interface DockerComposeConfig {
  enabled: boolean;
  paths: string[];
}

export interface CustomAnalyzerConfig {
  analyzerPath: string;
}
```

**Re-export from types/index.ts:**
```typescript
export * from './infrastructure.js';
```

**Testing:** No tests needed yet (types only).

---

### Phase 2: InfraAnalyzer Base Class (1 day)

#### 2.1 Create `packages/core/src/plugins/InfraAnalyzer.ts`

**Location:** New file in `packages/core/src/plugins/`

```typescript
/**
 * InfraAnalyzer — Base class for infrastructure analysis plugins
 *
 * AGENT DOCUMENTATION:
 *
 * Use InfraAnalyzer when analyzing infrastructure-as-code files:
 * - Kubernetes YAML manifests
 * - Terraform .tf files
 * - Docker Compose files
 * - Helm charts
 * - Cloud resource configs (AWS, GCP, Azure)
 * - Observability configs (Prometheus, Grafana)
 *
 * LIFECYCLE:
 *
 * 1. discoverFiles(context) — find infrastructure files matching patterns
 * 2. For each file:
 *    a. parseFile(filePath, content) — extract InfraResource[]
 *    b. For each resource:
 *       - Create graph node (via graph.addNode)
 *       - linkToCode(resource, graph) — create cross-layer edges
 *
 * PLUGIN-FIRST PHILOSOPHY:
 *
 * Grafema does NOT guess how code maps to infrastructure.
 * Developers write custom analyzers for their projects.
 *
 * EXAMPLE:
 *
 * ```typescript
 * class K8sYamlAnalyzer extends InfraAnalyzer {
 *   declareNodeTypes() { return ['infra:k8s:deployment', 'infra:k8s:service']; }
 *   declareEdgeTypes() { return ['DEPLOYED_TO', 'EXPOSED_VIA']; }
 *
 *   async discoverFiles(context) {
 *     const config = context.config?.infrastructure?.kubernetes;
 *     return glob(config.paths);
 *   }
 *
 *   parseFile(filePath, content) {
 *     const yaml = YAML.parse(content);
 *     return yaml.map(doc => ({
 *       id: `infra:k8s:${doc.kind.toLowerCase()}:${doc.metadata.name}`,
 *       type: `infra:k8s:${doc.kind.toLowerCase()}`,
 *       name: doc.metadata.name,
 *       file: filePath,
 *       env: doc.metadata.labels?.env,
 *       metadata: { ...doc.spec }
 *     }));
 *   }
 *
 *   async linkToCode(resource, graph) {
 *     // Plugin-specific logic: match deployment to SERVICE node
 *     const serviceNode = await graph.getNode(`SERVICE:${resource.name}`);
 *     if (serviceNode) {
 *       return [{ type: 'DEPLOYED_TO', src: serviceNode.id, dst: resource.id }];
 *     }
 *     return [];
 *   }
 * }
 * ```
 */

import { readFileSync } from 'fs';
import { Plugin, createSuccessResult, createErrorResult } from './Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from './Plugin.js';
import type { InfraResource, CrossLayerLink } from '@grafema/types';

export abstract class InfraAnalyzer extends Plugin {
  /**
   * Plugin metadata
   * Subclasses should override this to declare created types
   */
  get metadata(): PluginMetadata {
    return {
      name: this.constructor.name,
      phase: 'ANALYSIS',
      creates: {
        nodes: this.declareNodeTypes(),
        edges: this.declareEdgeTypes(),
      },
      dependencies: ['JSASTAnalyzer'], // Most infra analyzers need code nodes
    };
  }

  /**
   * Declare node types this analyzer creates
   * Examples: ['infra:k8s:deployment', 'infra:k8s:service']
   */
  abstract declareNodeTypes(): string[];

  /**
   * Declare edge types this analyzer creates
   * Examples: ['DEPLOYED_TO', 'CONFIGURED_BY']
   */
  abstract declareEdgeTypes(): string[];

  /**
   * Find infrastructure files to analyze
   * Read from context.config.infrastructure or use glob patterns
   *
   * @param context Plugin context with config
   * @returns Array of absolute file paths
   */
  abstract discoverFiles(context: PluginContext): Promise<string[]>;

  /**
   * Parse a single infrastructure file into resources
   * This method is file-format specific (YAML, HCL, JSON, etc.)
   *
   * @param filePath Absolute path to file
   * @param content File content
   * @returns Array of parsed resources (may be empty if file is invalid)
   */
  abstract parseFile(filePath: string, content: string): InfraResource[];

  /**
   * THE KEY METHOD: Link infrastructure resource to code
   *
   * This is where developers implement project-specific mapping logic.
   * Grafema does NOT guess — you decide how infra maps to code.
   *
   * Common patterns:
   * - Match deployment name to SERVICE node name
   * - Read annotations/labels for explicit service mapping
   * - Use config mappings from grafema.config.yaml
   * - Query graph for matching code nodes
   *
   * @param resource Infrastructure resource
   * @param graph Graph backend for querying code nodes
   * @returns Array of cross-layer edges (may be empty if no match)
   */
  abstract linkToCode(
    resource: InfraResource,
    graph: PluginContext['graph']
  ): Promise<CrossLayerLink[]>;

  /**
   * Execute infrastructure analysis
   * Orchestrates: discover → parse → create nodes → link to code
   */
  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph } = context;

      // Step 1: Discover files
      logger.info('Discovering infrastructure files');
      const files = await this.discoverFiles(context);
      logger.info('Files discovered', { count: files.length });

      if (files.length === 0) {
        logger.warn('No infrastructure files found');
        return createSuccessResult();
      }

      let nodesCreated = 0;
      let edgesCreated = 0;
      const errors: Error[] = [];

      // Step 2: Process each file
      for (const filePath of files) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          const resources = this.parseFile(filePath, content);

          logger.debug('Parsed file', { file: filePath, resources: resources.length });

          // Step 3: Create graph nodes for resources
          for (const resource of resources) {
            try {
              // Create node via graph.addNode
              // Node ID is resource.id, type is resource.type
              const node = {
                id: resource.id,
                type: resource.type,
                name: resource.name,
                file: resource.file,
                line: resource.line,
                metadata: {
                  ...resource.metadata,
                  env: resource.env, // Store environment metadata
                },
              };

              await graph.addNode(node as any);
              nodesCreated++;

              // Step 4: Link to code
              const links = await this.linkToCode(resource, graph);

              for (const link of links) {
                await graph.addEdge({
                  src: link.src,
                  dst: link.dst,
                  type: link.type,
                  ...link.metadata,
                });
                edgesCreated++;
              }
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              logger.warn('Failed to process resource', {
                resource: resource.id,
                error: err.message,
              });
              errors.push(err);
            }
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn('Failed to parse file', {
            file: filePath,
            error: err.message,
          });
          errors.push(err);
        }
      }

      logger.info('Analysis complete', { nodesCreated, edgesCreated });

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { filesProcessed: files.length },
        errors
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }
}
```

**Re-export from core/plugins/index.ts:**
```typescript
export { InfraAnalyzer } from './InfraAnalyzer.js';
```

**Testing:** See Phase 4.

---

### Phase 3: Configuration Schema (0.5 day)

#### 3.1 Update `OrchestratorConfig` type (`packages/types/src/plugins.ts`)

Add infrastructure config field:

**Location:** After line 221 (after `routing?: RoutingRule[];`)

```typescript
/**
 * Infrastructure analysis configuration (USG Phase 1).
 * See packages/types/src/infrastructure.ts for schema.
 */
infrastructure?: InfrastructureConfig;
```

**Import at top of file:**
```typescript
import type { InfrastructureConfig } from './infrastructure.js';
```

**Testing:** No tests needed (type extension only).

---

#### 3.2 Config Loader Validation (Optional)

Config validation happens in `packages/core/src/core/ConfigLoader.ts`. For now, we'll allow any shape under `infrastructure` key. Strict validation can be added later when we have real analyzers.

**Decision:** Skip config validation in Phase 1. Add when K8s analyzer is implemented (REG-364).

---

### Phase 4: Testing (1 day)

#### 4.1 Unit Tests for InfraAnalyzer (`test/unit/InfraAnalyzer.test.js`)

Create comprehensive tests:

```javascript
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { InfraAnalyzer } from '../../packages/core/dist/plugins/InfraAnalyzer.js';

/**
 * Mock InfraAnalyzer for testing base class behavior
 */
class MockInfraAnalyzer extends InfraAnalyzer {
  constructor(config = {}) {
    super(config);
    this.mockFiles = config.mockFiles || [];
    this.mockResources = config.mockResources || [];
    this.mockLinks = config.mockLinks || [];
  }

  declareNodeTypes() {
    return ['infra:test:resource'];
  }

  declareEdgeTypes() {
    return ['TEST_EDGE'];
  }

  async discoverFiles(context) {
    return this.mockFiles;
  }

  parseFile(filePath, content) {
    return this.mockResources;
  }

  async linkToCode(resource, graph) {
    return this.mockLinks;
  }
}

describe('InfraAnalyzer', () => {
  let graph;

  before(() => {
    // Mock graph backend
    const nodes = new Map();
    const edges = [];

    graph = {
      addNode: async (node) => {
        nodes.set(node.id, node);
      },
      addEdge: async (edge) => {
        edges.push(edge);
      },
      getNode: async (id) => nodes.get(id) || null,
      _getNodes: () => Array.from(nodes.values()),
      _getEdges: () => edges,
    };
  });

  it('should declare metadata correctly', () => {
    const analyzer = new MockInfraAnalyzer();
    const metadata = analyzer.metadata;

    assert.equal(metadata.name, 'MockInfraAnalyzer');
    assert.equal(metadata.phase, 'ANALYSIS');
    assert.deepEqual(metadata.creates.nodes, ['infra:test:resource']);
    assert.deepEqual(metadata.creates.edges, ['TEST_EDGE']);
  });

  it('should handle no files discovered', async () => {
    const analyzer = new MockInfraAnalyzer({ mockFiles: [] });
    const context = { graph, logger: console };

    const result = await analyzer.execute(context);

    assert.equal(result.success, true);
    assert.equal(result.created.nodes, 0);
    assert.equal(result.created.edges, 0);
  });

  it('should create nodes for discovered resources', async () => {
    const mockResource = {
      id: 'infra:test:resource:foo',
      type: 'infra:test:resource',
      name: 'foo',
      file: '/path/to/infra.yaml',
      line: 10,
      env: 'prod',
      metadata: { key: 'value' },
    };

    const analyzer = new MockInfraAnalyzer({
      mockFiles: ['/path/to/infra.yaml'],
      mockResources: [mockResource],
      mockLinks: [],
    });

    // Mock readFileSync
    const fs = await import('fs');
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = () => 'mock content';

    const context = { graph, logger: console };
    const result = await analyzer.execute(context);

    // Restore fs
    fs.readFileSync = originalReadFileSync;

    assert.equal(result.success, true);
    assert.equal(result.created.nodes, 1);
    assert.equal(result.created.edges, 0);

    const nodes = graph._getNodes();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].id, 'infra:test:resource:foo');
    assert.equal(nodes[0].type, 'infra:test:resource');
    assert.equal(nodes[0].metadata.env, 'prod');
  });

  it('should create cross-layer edges from linkToCode', async () => {
    const mockResource = {
      id: 'infra:test:resource:foo',
      type: 'infra:test:resource',
      name: 'foo',
      file: '/path/to/infra.yaml',
    };

    const mockLink = {
      type: 'DEPLOYED_TO',
      src: 'SERVICE:foo',
      dst: 'infra:test:resource:foo',
    };

    const analyzer = new MockInfraAnalyzer({
      mockFiles: ['/path/to/infra.yaml'],
      mockResources: [mockResource],
      mockLinks: [mockLink],
    });

    const fs = await import('fs');
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = () => 'mock content';

    const context = { graph, logger: console };
    const result = await analyzer.execute(context);

    fs.readFileSync = originalReadFileSync;

    assert.equal(result.success, true);
    assert.equal(result.created.nodes, 1);
    assert.equal(result.created.edges, 1);

    const edges = graph._getEdges();
    assert.equal(edges.length, 1);
    assert.equal(edges[0].type, 'DEPLOYED_TO');
    assert.equal(edges[0].src, 'SERVICE:foo');
    assert.equal(edges[0].dst, 'infra:test:resource:foo');
  });

  it('should handle parse errors gracefully', async () => {
    const analyzer = new MockInfraAnalyzer({
      mockFiles: ['/path/to/invalid.yaml'],
      mockResources: [],
      mockLinks: [],
    });

    // Mock readFileSync to throw
    const fs = await import('fs');
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = () => {
      throw new Error('Parse error');
    };

    const context = { graph, logger: console };
    const result = await analyzer.execute(context);

    fs.readFileSync = originalReadFileSync;

    assert.equal(result.success, true); // Graceful degradation
    assert.equal(result.created.nodes, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /Parse error/);
  });
});
```

**Test execution:**
```bash
pnpm build  # REQUIRED before tests
node --test test/unit/InfraAnalyzer.test.js
```

---

#### 4.2 Integration Test (Optional)

Integration test with real filesystem can be added in Phase 2 when we have K8s analyzer. For now, unit tests are sufficient.

---

### Phase 5: Documentation (0.5 day)

#### 5.1 Update `_ai/usg-architecture.md`

No changes needed — architecture is already documented. This task implements what's already specified there.

#### 5.2 Add AI Agent Guide (`_ai/infrastructure-plugins.md` — NEW FILE)

Create guide for AI agents writing infrastructure analyzers:

```markdown
# Infrastructure Plugins — AI Agent Guide

## When to Use

Use infrastructure plugins when analyzing:
- Kubernetes YAML manifests (deployments, services, ingress)
- Terraform .tf files (AWS, GCP, Azure resources)
- Docker Compose files (services, networks, volumes)
- Helm charts (templates, values)
- Cloud provider configs (CloudFormation, ARM templates)
- Observability configs (Prometheus rules, Grafana dashboards, SLOs)

## Base Class: InfraAnalyzer

Extend `InfraAnalyzer` for all infrastructure plugins.

```typescript
import { InfraAnalyzer } from '@grafema/core';
import type { InfraResource, CrossLayerLink, PluginContext } from '@grafema/types';

class MyInfraAnalyzer extends InfraAnalyzer {
  // 1. Declare what you create
  declareNodeTypes() {
    return ['infra:mytool:resource'];
  }

  declareEdgeTypes() {
    return ['DEPLOYED_TO', 'CONFIGURED_BY'];
  }

  // 2. Find files to analyze
  async discoverFiles(context: PluginContext): Promise<string[]> {
    const config = context.config?.infrastructure?.mytool;
    if (!config?.enabled) return [];

    // Use glob or filesystem API
    return glob(config.paths);
  }

  // 3. Parse file into resources
  parseFile(filePath: string, content: string): InfraResource[] {
    // Parse YAML, HCL, JSON, etc.
    const data = YAML.parse(content);

    return data.map(item => ({
      id: `infra:mytool:${item.kind}:${item.name}`,
      type: `infra:mytool:${item.kind}`,
      name: item.name,
      file: filePath,
      line: item.line,
      env: item.labels?.env, // Environment metadata
      metadata: { ...item.spec },
    }));
  }

  // 4. THE KEY METHOD: Link to code
  async linkToCode(resource: InfraResource, graph): Promise<CrossLayerLink[]> {
    // Plugin-specific logic: match infra to code
    // NO HEURISTICS — you decide the mapping

    // Example: match deployment name to SERVICE node
    const serviceNode = await graph.getNode(`SERVICE:${resource.name}`);
    if (serviceNode) {
      return [{
        type: 'DEPLOYED_TO',
        src: serviceNode.id,
        dst: resource.id,
      }];
    }

    return []; // No match found
  }
}
```

## Node Type Conventions

**Format:** `layer:tool:resource`

| Layer | Prefix | Examples |
|-------|--------|----------|
| Infrastructure | `infra:` | `infra:k8s:deployment`, `infra:docker:service` |
| Cloud | `cloud:` | `cloud:aws:lambda`, `cloud:gcp:function` |
| Observability | `obs:` | `obs:prometheus:rule`, `obs:grafana:dashboard` |

## Edge Direction Convention

**Dependent → Provider**

Always: the node that depends on another points TO the provider.

Examples:
- `SERVICE --DEPLOYED_TO--> infra:k8s:deployment` (service depends on deployment)
- `http:route --EXPOSED_VIA--> infra:k8s:ingress` (route depends on ingress)
- `infra:terraform:resource --PROVISIONS--> cloud:aws:lambda` (terraform creates lambda)

## Environment Metadata

Infrastructure nodes often have environment metadata (`env: "prod"`).

```typescript
const resource: InfraResource = {
  id: 'infra:k8s:deployment:api',
  type: 'infra:k8s:deployment',
  name: 'api',
  file: 'k8s/prod/api.yaml',
  env: 'prod', // Single environment
  metadata: {},
};

// OR multiple environments
const multiEnvResource: InfraResource = {
  id: 'infra:terraform:lambda:processor',
  type: 'infra:terraform:lambda',
  name: 'processor',
  file: 'terraform/lambda.tf',
  env: ['staging', 'prod'], // Deployed to both
  metadata: {},
};
```

Query filtering (Datalog):
```datalog
// Find prod deployments only
prod_deployments(D) :-
  node(D, Type, _, Meta),
  string_concat("infra:k8s:", _, Type),
  json_get(Meta, "env", "prod").
```

## Cross-Layer Edge Types

### Code <-> Infrastructure
| Edge | Direction | Question |
|------|-----------|----------|
| DEPLOYED_TO | SERVICE → infra:k8s:deployment | "Where is this deployed?" |
| CONFIGURED_BY | SERVICE → infra:k8s:configmap | "What config does this use?" |
| USES_SECRET | SERVICE → infra:k8s:secret | "What secrets does this need?" |
| EXPOSED_VIA | http:route → infra:k8s:ingress | "How is this exposed?" |
| SCHEDULED_BY | FUNCTION → infra:k8s:cronjob | "When does this run?" |

### Infrastructure <-> Cloud
| Edge | Direction | Question |
|------|-----------|----------|
| PROVISIONS | infra:terraform → cloud:aws:* | "What does this IaC create?" |
| TARGETS | infra:k8s:deployment → cloud:aws:eks | "What cluster?" |

### Code <-> Cloud
| Edge | Direction | Question |
|------|-----------|----------|
| PUBLISHES_TO | FUNCTION → cloud:aws:sqs | "Where send messages?" |
| SUBSCRIBES_TO | FUNCTION → cloud:aws:sqs | "What queue consume?" |
| STORES_IN | FUNCTION → cloud:aws:s3 | "Where persist data?" |

### Any <-> Observability
| Edge | Direction | Question |
|------|-----------|----------|
| MONITORED_BY | SERVICE → obs:prometheus:rule | "What alerts watch this?" |
| MEASURED_BY | http:route → obs:slo | "What SLO covers this?" |
| VISUALIZED_IN | SERVICE → obs:grafana:dashboard | "Where see metrics?" |
| LOGS_TO | SERVICE → cloud:aws:cloudwatch | "Where are logs?" |

## Configuration

Add to `grafema.config.yaml`:

```yaml
infrastructure:
  enabled: true

  kubernetes:
    enabled: true
    paths:
      - 'k8s/**/*.yaml'
    mappings:
      - deployment: 'user-api'
        service: 'apps/user-api'

  terraform:
    enabled: false
    paths:
      - 'terraform/**/*.tf'
```

Access in analyzer:
```typescript
async discoverFiles(context: PluginContext): Promise<string[]> {
  const config = context.config?.infrastructure?.kubernetes;
  if (!config?.enabled) return [];
  return glob(config.paths);
}
```

## Error Handling

**Graceful degradation:** Failed files don't fail the entire analysis.

```typescript
parseFile(filePath: string, content: string): InfraResource[] {
  try {
    const data = YAML.parse(content);
    return data.map(parseResource);
  } catch (error) {
    // Log warning, return empty array
    // InfraAnalyzer base class will log the error
    return [];
  }
}
```

**Link failures:** If `linkToCode()` can't find matching code node, return empty array. Don't throw.

```typescript
async linkToCode(resource, graph): Promise<CrossLayerLink[]> {
  const serviceNode = await graph.getNode(`SERVICE:${resource.name}`);
  if (!serviceNode) {
    return []; // No match — not an error
  }
  return [{ type: 'DEPLOYED_TO', src: serviceNode.id, dst: resource.id }];
}
```

## Reference Implementation

See `packages/core/src/plugins/analysis/K8sYamlAnalyzer.ts` (REG-364) for full working example.
```

---

### Phase 6: Type Exports (0.25 day)

#### 6.1 Update `packages/types/src/index.ts`

Add export for infrastructure types:

```typescript
export * from './infrastructure.js';
```

#### 6.2 Update `packages/core/src/plugins/index.ts`

Add export for InfraAnalyzer:

```typescript
export { InfraAnalyzer } from './InfraAnalyzer.js';
```

---

## Execution Order

1. **Phase 1:** Edge types (0.5 day)
   - Add to `edges.ts`
   - Create `infrastructure.ts`
   - Re-export from `types/index.ts`

2. **Phase 2:** InfraAnalyzer base class (1 day)
   - Create `InfraAnalyzer.ts`
   - Re-export from `core/plugins/index.ts`

3. **Phase 3:** Config schema (0.5 day)
   - Update `OrchestratorConfig`

4. **Phase 4:** Tests (1 day)
   - Write unit tests
   - Run and verify

5. **Phase 5:** Documentation (0.5 day)
   - Create AI agent guide

6. **Phase 6:** Type exports (0.25 day)
   - Update index files

**Total estimated time:** 3.75 days → round to **4 days** with buffer.

---

## Testing Strategy

### Unit Tests
- InfraAnalyzer base class behavior (lifecycle, error handling)
- Mock analyzer with simple parseFile/linkToCode implementations
- Edge cases: no files, parse errors, link failures

### Integration Tests
- Deferred to Phase 2 (REG-364 K8s analyzer)
- Will test with real YAML files and graph

### Manual Testing
- Import InfraAnalyzer in a script
- Verify TypeScript compilation
- Check metadata declarations

---

## Risk Analysis

### Low Risk
- Edge type additions (just string constants)
- Type definitions (no runtime code)
- Base class structure (well-defined interface from architecture)

### Medium Risk
- `execute()` orchestration logic — must handle errors gracefully
- File reading (what if file doesn't exist after discovery?)
- Graph operations (addNode/addEdge failure modes)

**Mitigation:**
- Wrap file operations in try/catch per file
- Wrap resource processing in try/catch per resource
- Log warnings, don't fail entire analysis on single resource

### Dependencies
- No external dependencies beyond existing graph backend
- Uses standard `fs.readFileSync` (already used by other analyzers)
- Glob patterns handled by analyzer implementations (not base class)

---

## Success Criteria

✅ **Code:**
- InfraAnalyzer base class compiles without errors
- All 16 cross-layer edge types added to `edges.ts`
- `infrastructure.ts` types exported from `@grafema/types`

✅ **Tests:**
- Unit tests pass for InfraAnalyzer lifecycle
- Mock analyzer demonstrates all phases (discover → parse → link)

✅ **Documentation:**
- AI agent guide created with examples
- Edge type table complete with direction conventions

✅ **Validation:**
- TypeScript compilation succeeds
- `pnpm build` produces clean dist output
- No breaking changes to existing analyzers (DatabaseAnalyzer, SocketIOAnalyzer continue working)

---

## Next Steps (After REG-363)

**REG-364:** K8s YAML Analyzer (reference implementation)
- Implement `K8sYamlAnalyzer extends InfraAnalyzer`
- Parse K8s manifests (Deployment, Service, Ingress, ConfigMap, Secret)
- Link to SERVICE nodes via name matching
- Integration tests with real K8s YAML files

**REG-365:** Terraform Analyzer (advanced use case)
- Parse .tf HCL files
- Create both `infra:terraform:*` and `cloud:*` nodes
- PROVISIONS edges from terraform to cloud resources

---

## Sources

Research references:
- [Backstage Architecture Overview](https://backstage.io/docs/overview/architecture-overview/)
- [Top Backstage Plugins for Infrastructure Automation (2026)](https://stackgen.com/blog/top-backstage-plugins-for-infrastructure-automation-2026-edition)
- [Static Analysis of Infrastructure as Code: a Survey](https://arxiv.org/pdf/2206.10344)
- [IaC Scanning Tools](https://spacelift.io/blog/iac-scanning-tools)
- [Multilayer Networks (Oxford Academic)](https://academic.oup.com/comnet/article/2/3/203/2841130)
- [gCore: Cross-layer Cohesiveness in Multi-layer Graphs](https://www.vldb.org/pvldb/vol16/p3201-zou.pdf)
