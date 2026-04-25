# REG-38: Universal System Graph - Plugin-First Architecture

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-06
**Status:** Revised Analysis (Post User Clarification)

---

## Executive Summary

This is a **complete rewrite** of the USG architecture based on user clarification.

**The fundamental insight:**
Grafema does NOT try to "guess" how code links to infrastructure. Identity resolution via heuristics is the WRONG approach.

**The correct approach:**
1. Grafema provides **abstract node types** for infrastructure layers (`infra:k8s:*`, `cloud:aws:*`, `obs:*`)
2. Grafema provides **base analyzers** as reference implementations for common cases
3. **Developers write custom analyzers** for their specific projects (likely via AI agents)
4. This is the same pattern as existing **Discovery plugins** - developer declares where to look

**Key quote from user (Vadim):**
> "У нас TS templates используются для кубера, потом через ArgoCD деплоится, это никакими эвристиками не поймаешь"

Translation: "We use TS templates for Kubernetes, then deploy via ArgoCD - no heuristics can figure this out."

**This means:**
- No Identity Resolution heuristics
- No auto-discovery magic
- No "smart" guessing

**What we build:**
1. Architectural Guidelines - principles for AI agents writing infra plugins
2. Plugin Interfaces - formal API for custom analyzers
3. Reference Implementations - examples for common tools (K8s YAML, Docker Compose, etc.)

---

## 1. Prior Art Research: Plugin Extensibility Patterns

### 1.1 Plugin Architecture Best Practices

Based on [plugin architecture research](https://medium.com/omarelgabrys-blog/plug-in-architecture-dec207291800) and [ArjanCodes guide](https://arjancodes.com/blog/best-practices-for-decoupling-software-using-plugins/):

**Core Principles:**
- **Clear Interfaces**: Plugin interface is a contract that every plugin must adhere to
- **Loose Coupling**: Independence between core and plugins
- **Extension Points**: Core declares hooks, plugins register into them

**Eclipse/VSCode Pattern:**
- Core handles stable fundamentals
- Everything else comes from plugins/extensions
- Massive community of extension developers

**Key insight for Grafema:** The value is in providing a clear contract + good reference implementations. Let users (and their AI agents) build domain-specific analyzers.

### 1.2 Backstage Entity Model

From [Backstage extending model](https://backstage.io/docs/features/software-catalog/extending-the-model/):

**Custom Entity Kinds:**
- Declare TypeScript type + JSONSchema for new entity kind
- Create custom processor for ingestion and validation
- Organizations express variety via `spec.type` within generic "Kinds"

**Plugin Development:**
- Copy existing package, rename, customize
- Define entity interfaces
- Register via plugin registry

**Key insight for Grafema:** Backstage provides generic buckets (Component, Resource, API), and users define specific types within them. Grafema should do the same: generic layer prefixes, specific types via plugins.

### 1.3 Static Analysis Tool Extensibility

From [PMD](https://pmd.github.io/) and [Dart analyzer plugins](https://dart.dev/tools/analyzer-plugins):

**PMD Pattern:**
- Extensible multilanguage analyzer
- Custom rules via Java or XPath queries
- Rules run against AST, find violations

**Dart Analyzer Pattern:**
- `PluginRegistry` for registering diagnostics, quick fixes, assists
- Entry point method for registration
- Clear separation: analyzer core vs. user-defined rules

**Key insight for Grafema:** Grafema already follows this pattern with ANALYSIS/ENRICHMENT phases. Infrastructure analyzers are just another plugin category.

### 1.4 Kubernetes Analysis Tools

From [kube-score](https://github.com/zegl/kube-score) and [KubeLinter](https://github.com/stackrox/kube-linter):

**KubeLinter Pattern:**
- Checks K8s YAML against best practices
- **Configurable**: Enable/disable checks
- **Custom checks**: Define organization-specific policies
- Focus: production readiness and security

**Key insight for Grafema:** These tools validate K8s YAML, but don't link to code. Grafema's value is in the **cross-layer linking** that custom analyzers provide.

---

## 2. Architectural Principles

### 2.1 Core Thesis: Plugin-First, Not Heuristics-First

**Old approach (REJECTED):**
```
Code Analysis -> Infra Analysis -> Heuristic Matcher -> Cross-layer Edges
                                   ^^^^^^^^^^^^^^
                                   This doesn't work for real projects
```

**New approach (APPROVED):**
```
Code Analysis -> Custom Infra Analyzer -> Cross-layer Edges
                 ^^^^^^^^^^^^^^^^^^^^^^
                 Developer writes this for their specific setup
```

### 2.2 Division of Responsibility

| Grafema Provides | Developer Provides |
|------------------|-------------------|
| Abstract node types (`infra:k8s:*`, etc.) | Custom analyzer for their specific infra setup |
| Plugin interfaces and base classes | Configuration telling analyzer where to look |
| Reference implementations (examples) | Domain knowledge about their code-to-infra mapping |
| Edge types for cross-layer linking | Explicit declaration of linking rules |
| Datalog queries for guarantees | Custom guarantees for their invariants |

### 2.3 Why This Works

1. **No magic to break:** Heuristics fail for edge cases. Explicit configuration always works.

2. **AI-friendly:** AI agents can generate custom analyzers by:
   - Reading project documentation
   - Looking at file structure
   - Following reference implementations

3. **Incremental adoption:** Teams add infra analysis one layer at a time, as needed.

4. **Matches Grafema pattern:** Discovery plugins already work this way - developer configures where services are, not auto-detection.

---

## 3. Plugin Interface Specification

### 3.1 InfraAnalyzer Base Class

```typescript
/**
 * Base class for infrastructure analysis plugins.
 *
 * WHEN TO USE:
 * - You have infrastructure config files (K8s YAML, Terraform, Docker Compose)
 * - You want to create nodes representing infrastructure resources
 * - You want to link code entities to infrastructure resources
 *
 * HOW IT WORKS:
 * 1. Discovery: Find infrastructure files in project
 * 2. Parsing: Parse files into structured data
 * 3. Node Creation: Create infra:* nodes for resources
 * 4. Edge Creation: Link code nodes to infra nodes
 *
 * IMPORTANT: Cross-layer linking is YOUR responsibility.
 * Grafema does NOT guess how code maps to infrastructure.
 * You must implement linkToCode() based on your project's conventions.
 */
abstract class InfraAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: this.constructor.name,
      phase: 'ANALYSIS',
      priority: 50,  // After code analysis (80), before enrichment
      creates: {
        nodes: this.declareNodeTypes(),
        edges: this.declareEdgeTypes(),
      },
      dependencies: ['JSASTAnalyzer'],  // Need code analysis first
    };
  }

  /**
   * Declare node types this analyzer creates.
   * Override to specify your node types.
   *
   * @example
   * return ['infra:k8s:deployment', 'infra:k8s:service'];
   */
  abstract declareNodeTypes(): string[];

  /**
   * Declare edge types this analyzer creates.
   * Override to specify your edge types.
   *
   * @example
   * return ['DEPLOYED_TO', 'EXPOSES_PORT'];
   */
  abstract declareEdgeTypes(): string[];

  /**
   * Find infrastructure files in the project.
   *
   * @param context Plugin context with projectPath
   * @returns Array of file paths to analyze
   *
   * @example
   * const files = await glob('k8s/**\/*.yaml', { cwd: context.projectPath });
   */
  abstract discoverFiles(context: PluginContext): Promise<string[]>;

  /**
   * Parse a single infrastructure file.
   *
   * @param filePath Path to the file
   * @param content File contents
   * @returns Parsed infrastructure resources
   */
  abstract parseFile(filePath: string, content: string): InfraResource[];

  /**
   * Link infrastructure resource to code entities.
   *
   * THIS IS THE KEY METHOD. You implement your project's linking logic here.
   *
   * @param resource Parsed infrastructure resource
   * @param graph Graph to query for code nodes
   * @returns Array of (code node ID, edge type) to link
   *
   * @example
   * // Explicit linking via annotation
   * if (resource.annotations?.['grafema.io/service']) {
   *   const serviceId = resource.annotations['grafema.io/service'];
   *   return [{ codeNodeId: `SERVICE#${serviceId}`, edgeType: 'DEPLOYED_TO' }];
   * }
   *
   * // Convention-based linking
   * const serviceName = resource.name;  // e.g., "user-api"
   * const serviceNode = await graph.queryNodes({ type: 'SERVICE', name: serviceName });
   * if (serviceNode) {
   *   return [{ codeNodeId: serviceNode.id, edgeType: 'DEPLOYED_TO' }];
   * }
   *
   * // No match - create ISSUE node
   * return [];
   */
  abstract linkToCode(
    resource: InfraResource,
    graph: PluginContext['graph']
  ): Promise<CrossLayerLink[]>;

  /**
   * Main execution - orchestrates the pipeline.
   * Usually you don't override this.
   */
  async execute(context: PluginContext): Promise<PluginResult> {
    const files = await this.discoverFiles(context);

    let nodesCreated = 0;
    let edgesCreated = 0;
    const unlinkedResources: string[] = [];

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8');
      const resources = this.parseFile(filePath, content);

      for (const resource of resources) {
        // Create infra node
        const node = this.createNode(resource, filePath);
        await context.graph.addNode(node);
        nodesCreated++;

        // Link to code
        const links = await this.linkToCode(resource, context.graph);

        if (links.length === 0) {
          unlinkedResources.push(resource.name);
        }

        for (const link of links) {
          await context.graph.addEdge({
            src: link.codeNodeId,
            dst: node.id,
            type: link.edgeType,
          });
          edgesCreated++;
        }
      }
    }

    // Report unlinked resources as ISSUE nodes
    for (const resourceName of unlinkedResources) {
      await this.createUnlinkedIssue(resourceName, context.graph);
    }

    return createSuccessResult({ nodes: nodesCreated, edges: edgesCreated });
  }

  private createUnlinkedIssue(resourceName: string, graph: Graph): void {
    const issueNode = {
      id: `ISSUE#unlinked-infra#${resourceName}`,
      type: 'ISSUE',
      name: `Unlinked infrastructure: ${resourceName}`,
      severity: 'warning',
      code: 'UNLINKED_INFRASTRUCTURE',
      message: `Infrastructure resource '${resourceName}' has no linked code entity`,
      suggestions: [
        `Add grafema.io/service annotation to link to a SERVICE node`,
        `Implement custom linkToCode() logic in your analyzer`,
        `Add explicit mapping in grafema.config.yaml`,
      ],
    };
    graph.addNode(issueNode);
  }
}

/**
 * Parsed infrastructure resource.
 */
interface InfraResource {
  name: string;
  kind: string;  // e.g., 'Deployment', 'Service', 'ConfigMap'
  namespace?: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  spec: Record<string, unknown>;
  raw: unknown;  // Original parsed data
}

/**
 * Cross-layer link specification.
 */
interface CrossLayerLink {
  codeNodeId: string;
  edgeType: string;
  metadata?: Record<string, unknown>;
}
```

### 3.2 Configuration Schema

```yaml
# grafema.config.yaml

# Infrastructure analysis configuration
infrastructure:
  # Enable/disable infra analysis globally
  enabled: true

  # Kubernetes analysis
  kubernetes:
    enabled: true
    # Where to find manifests
    paths:
      - 'k8s/**/*.yaml'
      - 'kubernetes/**/*.yaml'
      - 'deploy/**/*.yaml'
    # Explicit code-to-infra mappings (override auto-detection)
    mappings:
      - deployment: 'user-api'
        service: 'apps/user-api'  # Path to SERVICE
      - deployment: 'order-processor'
        service: 'apps/orders'
    # Custom linking rules (evaluated in order)
    linkingRules:
      # By annotation
      - type: 'annotation'
        annotationKey: 'grafema.io/service'
      # By label
      - type: 'label'
        labelKey: 'app.kubernetes.io/name'
      # By directory convention
      - type: 'directory'
        pattern: 'apps/{name}/'  # {name} captures from deployment name

  # Docker Compose analysis
  dockerCompose:
    enabled: false
    paths:
      - 'docker-compose.yaml'
      - 'docker-compose.*.yaml'

  # Terraform analysis
  terraform:
    enabled: false
    paths:
      - 'terraform/**/*.tf'
      - 'infra/**/*.tf'

  # Custom analyzer (for project-specific infra)
  custom:
    # Path to custom analyzer module
    analyzerPath: '.grafema/analyzers/my-infra-analyzer.ts'
```

---

## 4. Namespace and Node Type Conventions

### 4.1 Layer Prefixes

```typescript
/**
 * Layer prefixes for infrastructure node types.
 *
 * Convention: layer:tool:resource
 *
 * Examples:
 *   infra:k8s:deployment
 *   infra:k8s:service
 *   infra:terraform:resource
 *   cloud:aws:lambda
 *   cloud:aws:sqs
 *   obs:prometheus:alert
 *   obs:datadog:monitor
 */
const LAYER_PREFIX = {
  // Infrastructure layer (container orchestration, IaC)
  infra: 'infra:',

  // Cloud provider resources
  cloud: 'cloud:',

  // Observability (alerts, SLOs, monitors)
  obs: 'obs:',
} as const;
```

### 4.2 Standard Node Types

These are **examples**, not an exhaustive list. Custom analyzers can create any node type following the convention.

```typescript
/**
 * Standard infrastructure node types.
 * Each analyzer declares which types it creates via declareNodeTypes().
 */
const INFRA_NODE_TYPES = {
  // Kubernetes
  'infra:k8s:deployment': 'Kubernetes Deployment',
  'infra:k8s:service': 'Kubernetes Service',
  'infra:k8s:configmap': 'Kubernetes ConfigMap',
  'infra:k8s:secret': 'Kubernetes Secret',
  'infra:k8s:ingress': 'Kubernetes Ingress',
  'infra:k8s:cronjob': 'Kubernetes CronJob',
  'infra:k8s:job': 'Kubernetes Job',
  'infra:k8s:statefulset': 'Kubernetes StatefulSet',
  'infra:k8s:daemonset': 'Kubernetes DaemonSet',

  // Docker
  'infra:docker:service': 'Docker Compose Service',
  'infra:docker:volume': 'Docker Volume',
  'infra:docker:network': 'Docker Network',

  // Terraform
  'infra:terraform:resource': 'Terraform Resource',
  'infra:terraform:module': 'Terraform Module',
  'infra:terraform:data': 'Terraform Data Source',

  // Helm
  'infra:helm:chart': 'Helm Chart',
  'infra:helm:release': 'Helm Release',

  // Cloud: AWS
  'cloud:aws:lambda': 'AWS Lambda Function',
  'cloud:aws:sqs': 'AWS SQS Queue',
  'cloud:aws:sns': 'AWS SNS Topic',
  'cloud:aws:s3': 'AWS S3 Bucket',
  'cloud:aws:dynamodb': 'AWS DynamoDB Table',
  'cloud:aws:rds': 'AWS RDS Instance',
  'cloud:aws:ecs:service': 'AWS ECS Service',
  'cloud:aws:ecs:task': 'AWS ECS Task Definition',

  // Cloud: GCP
  'cloud:gcp:function': 'Google Cloud Function',
  'cloud:gcp:pubsub:topic': 'Google Pub/Sub Topic',
  'cloud:gcp:storage': 'Google Cloud Storage Bucket',

  // Cloud: Azure
  'cloud:azure:function': 'Azure Function',
  'cloud:azure:servicebus': 'Azure Service Bus',

  // Observability
  'obs:prometheus:rule': 'Prometheus Alert Rule',
  'obs:grafana:dashboard': 'Grafana Dashboard',
  'obs:datadog:monitor': 'Datadog Monitor',
  'obs:pagerduty:service': 'PagerDuty Service',
  'obs:slo': 'SLO Definition',
} as const;
```

### 4.3 Node Type Metadata Schema

All infrastructure nodes should include standardized metadata fields:

```typescript
interface InfraNodeMetadata {
  // Common fields
  namespace?: string;        // K8s namespace, cloud region, etc.
  labels?: Record<string, string>;
  annotations?: Record<string, string>;

  // For linking
  serviceIdentifier?: string;  // Explicit link target (e.g., 'user-api')
  codePathHint?: string;       // Hint for code location (e.g., 'apps/users')

  // Tool-specific
  [key: string]: unknown;
}

interface InfraNodeRecord extends BaseNodeRecord {
  type: string;  // e.g., 'infra:k8s:deployment'

  // Infrastructure-specific required fields
  resourceKind: string;  // Original resource kind (e.g., 'Deployment')
  resourceName: string;  // Resource name in the tool

  // Source file
  file: string;
  line?: number;

  metadata: InfraNodeMetadata;
}
```

---

## 5. Edge Types for Cross-Layer Linking

### 5.1 Cross-Layer Edge Types

```typescript
/**
 * Edge types for connecting code to infrastructure.
 */
const CROSS_LAYER_EDGES = {
  // Code -> Infrastructure
  DEPLOYED_TO: 'DEPLOYED_TO',      // SERVICE -> infra:k8s:deployment
  CONFIGURED_BY: 'CONFIGURED_BY',  // FUNCTION -> infra:k8s:configmap
  USES_SECRET: 'USES_SECRET',      // VARIABLE -> infra:k8s:secret

  // Infrastructure -> Infrastructure
  EXPOSES: 'EXPOSES',              // infra:k8s:deployment -> infra:k8s:service
  ROUTES_TO: 'ROUTES_TO',          // infra:k8s:ingress -> infra:k8s:service
  DEPENDS_ON: 'DEPENDS_ON',        // infra:terraform:resource -> infra:terraform:resource

  // Infrastructure -> Cloud
  PROVISIONED_BY: 'PROVISIONED_BY', // infra:terraform:resource -> cloud:aws:*
  TARGETS: 'TARGETS',               // infra:k8s:deployment -> cloud:aws:ecs:service

  // Code -> Cloud
  INVOKES: 'INVOKES',              // FUNCTION -> cloud:aws:lambda
  PUBLISHES_TO: 'PUBLISHES_TO',    // FUNCTION -> cloud:aws:sqs
  SUBSCRIBES_FROM: 'SUBSCRIBES_FROM', // FUNCTION -> cloud:aws:sqs
  STORES_IN: 'STORES_IN',          // FUNCTION -> cloud:aws:s3

  // Code/Infra -> Observability
  MONITORED_BY: 'MONITORED_BY',    // SERVICE -> obs:prometheus:rule
  ALERTED_BY: 'ALERTED_BY',        // SERVICE -> obs:datadog:monitor
  MEASURED_BY: 'MEASURED_BY',      // http:route -> obs:slo
} as const;
```

### 5.2 Edge Direction Convention

```
Code Entity -----> Infrastructure Entity -----> Cloud Entity
                          |
                          v
                   Observability Entity
```

**Direction rules:**
- Code DEPLOYED_TO infrastructure (code is subject, infra is target)
- Infrastructure PROVISIONED_BY cloud (infra is subject, cloud is target)
- Entity MONITORED_BY observability (entity is subject, obs is target)

This keeps the direction consistent: the "dependent" entity points to the "provider" entity.

---

## 6. Reference Implementation Plans

### 6.1 K8sYamlAnalyzer (Reference Implementation)

**Purpose:** Analyze Kubernetes YAML manifests and create `infra:k8s:*` nodes.

**What it does:**
1. Discover YAML files in configured paths
2. Parse multi-document YAML (for manifests with `---` separators)
3. Create nodes for Deployments, Services, ConfigMaps, etc.
4. Link to code via configurable rules

**Implementation sketch:**

```typescript
class K8sYamlAnalyzer extends InfraAnalyzer {
  declareNodeTypes() {
    return [
      'infra:k8s:deployment',
      'infra:k8s:service',
      'infra:k8s:configmap',
      'infra:k8s:secret',
      'infra:k8s:ingress',
    ];
  }

  declareEdgeTypes() {
    return ['DEPLOYED_TO', 'EXPOSES', 'ROUTES_TO', 'CONFIGURED_BY'];
  }

  async discoverFiles(context: PluginContext): Promise<string[]> {
    const config = context.config?.infrastructure?.kubernetes;
    const patterns = config?.paths || ['k8s/**/*.yaml'];

    const files: string[] = [];
    for (const pattern of patterns) {
      files.push(...await glob(pattern, { cwd: context.projectPath }));
    }
    return files;
  }

  parseFile(filePath: string, content: string): InfraResource[] {
    // Handle multi-document YAML
    const docs = yaml.parseAllDocuments(content);
    return docs.map(doc => {
      const data = doc.toJSON();
      return {
        name: data.metadata?.name,
        kind: data.kind,
        namespace: data.metadata?.namespace,
        annotations: data.metadata?.annotations,
        labels: data.metadata?.labels,
        spec: data.spec,
        raw: data,
      };
    }).filter(r => r.name && r.kind);
  }

  async linkToCode(
    resource: InfraResource,
    graph: Graph
  ): Promise<CrossLayerLink[]> {
    const links: CrossLayerLink[] = [];

    // Strategy 1: Explicit annotation
    const serviceId = resource.annotations?.['grafema.io/service'];
    if (serviceId) {
      const node = await graph.getNode(`SERVICE#${serviceId}`);
      if (node) {
        links.push({ codeNodeId: node.id, edgeType: 'DEPLOYED_TO' });
        return links;
      }
    }

    // Strategy 2: Label-based matching
    const appName = resource.labels?.['app.kubernetes.io/name'];
    if (appName) {
      for await (const node of graph.queryNodes({ type: 'SERVICE' })) {
        if (node.name === appName) {
          links.push({ codeNodeId: node.id, edgeType: 'DEPLOYED_TO' });
          return links;
        }
      }
    }

    // Strategy 3: Check explicit mappings in config
    // ... (read from context.config)

    // No match - return empty, base class will create ISSUE
    return links;
  }
}
```

**Effort:** 3-5 days

### 6.2 DockerComposeAnalyzer (Reference Implementation)

**Purpose:** Analyze Docker Compose files and create `infra:docker:*` nodes.

**What it does:**
1. Parse `docker-compose.yaml` and variants
2. Create nodes for services, volumes, networks
3. Link to code via build context paths or image names

**Implementation sketch:**

```typescript
class DockerComposeAnalyzer extends InfraAnalyzer {
  declareNodeTypes() {
    return ['infra:docker:service', 'infra:docker:volume', 'infra:docker:network'];
  }

  parseFile(filePath: string, content: string): InfraResource[] {
    const compose = yaml.parse(content);
    const resources: InfraResource[] = [];

    for (const [name, service] of Object.entries(compose.services || {})) {
      resources.push({
        name,
        kind: 'service',
        spec: service as Record<string, unknown>,
        raw: service,
      });
    }

    // Also parse volumes, networks...
    return resources;
  }

  async linkToCode(resource: InfraResource, graph: Graph): Promise<CrossLayerLink[]> {
    const links: CrossLayerLink[] = [];
    const spec = resource.spec;

    // Link via build context
    if (spec.build) {
      const buildContext = typeof spec.build === 'string'
        ? spec.build
        : spec.build.context;

      // Find SERVICE at this path
      for await (const node of graph.queryNodes({ type: 'SERVICE' })) {
        if (node.metadata?.path === buildContext) {
          links.push({ codeNodeId: node.id, edgeType: 'DEPLOYED_TO' });
          return links;
        }
      }
    }

    return links;
  }
}
```

**Effort:** 2-3 days

### 6.3 TerraformAnalyzer (Reference Implementation)

**Purpose:** Analyze Terraform `.tf` files and create `infra:terraform:*` and `cloud:*` nodes.

**What it does:**
1. Parse HCL files
2. Create nodes for resources, modules, data sources
3. Extract cloud resources (aws_lambda_function, etc.)
4. Link to code via explicit references or conventions

**Implementation sketch:**

```typescript
class TerraformAnalyzer extends InfraAnalyzer {
  declareNodeTypes() {
    return [
      'infra:terraform:resource',
      'infra:terraform:module',
      'cloud:aws:lambda',
      'cloud:aws:sqs',
      // ... etc
    ];
  }

  parseFile(filePath: string, content: string): InfraResource[] {
    // Use terraform-json or hcl2-json parser
    const hcl = parseHCL(content);
    const resources: InfraResource[] = [];

    for (const [type, resources] of Object.entries(hcl.resource || {})) {
      for (const [name, config] of Object.entries(resources)) {
        resources.push({
          name: `${type}.${name}`,
          kind: type,
          spec: config,
          raw: config,
          metadata: {
            terraformType: type,
          },
        });
      }
    }

    return resources;
  }

  async linkToCode(resource: InfraResource, graph: Graph): Promise<CrossLayerLink[]> {
    // For Lambda: check handler reference
    if (resource.kind === 'aws_lambda_function') {
      const handler = resource.spec.handler;  // e.g., "dist/index.handler"
      // Find FUNCTION with matching export...
    }

    // For SQS: check if code references queue name
    // ...

    return [];
  }
}
```

**Effort:** 4-6 days (HCL parsing is non-trivial)

### 6.4 NginxConfigAnalyzer (Reference Implementation)

**Purpose:** Analyze Nginx configuration files and create routing nodes.

**What it does:**
1. Parse nginx.conf and included files
2. Create nodes for server blocks, location blocks
3. Link to code via upstream references or path patterns

**Effort:** 3-4 days

---

## 7. Implementation Roadmap

### Phase 1: Infrastructure Framework (2-3 weeks)

**Deliverables:**
1. `InfraAnalyzer` base class with documented contract
2. Configuration schema for `grafema.config.yaml`
3. Namespace convention documentation
4. Cross-layer edge types

**Why first:** This establishes the foundation. Without the framework, reference implementations have nothing to extend.

### Phase 2: K8s Reference Implementation (1 week)

**Deliverables:**
1. `K8sYamlAnalyzer` plugin
2. Tests against sample K8s manifests
3. Documentation with examples

**Why second:** Kubernetes is the most common infrastructure target. Provides concrete example for other analyzers.

### Phase 3: Additional Reference Implementations (2-3 weeks)

**Deliverables:**
1. `DockerComposeAnalyzer`
2. `TerraformAnalyzer` (basic AWS resources)
3. `NginxConfigAnalyzer` (optional)

**Why third:** Expands coverage, provides more examples for custom analyzers.

### Phase 4: AI Agent Documentation (1 week)

**Deliverables:**
1. Guide: "Writing Custom Infrastructure Analyzers"
2. Prompt templates for AI-assisted analyzer generation
3. Example: generating analyzer from project description

**Why last:** After implementations exist, we can document patterns for AI agents to follow.

---

## 8. What This Approach Does NOT Include

**Explicitly out of scope:**

1. **Identity Resolution heuristics** - No guessing. Developers declare mappings.

2. **Auto-discovery magic** - No scanning for patterns. Explicit configuration.

3. **Exhaustive node type catalog** - Provide examples, not complete list.

4. **Multi-repo support** - Phase 1 focuses on single-repo/monorepo. Multi-repo is separate feature.

5. **Runtime integration** - No K8s API calls, no AWS API calls. Static analysis only.

6. **Observability layer** - Deferred. Start with infra/cloud, add observability later.

---

## 9. Open Questions

### 9.1 Node Type Registration

**Question:** Should custom analyzers register their node types formally, or just use them?

**Options:**
A) Just use them (current pattern - node type is just a string)
B) Formal registration with schema validation
C) Optional registration for documentation/tooling

**Recommendation:** Option A for now. Formal registration adds complexity without clear benefit until we have tooling that needs it.

### 9.2 Edge Metadata for Linking

**Question:** Should cross-layer edges include linking method in metadata?

**Example:**
```typescript
{
  type: 'DEPLOYED_TO',
  src: 'SERVICE#user-api',
  dst: 'infra:k8s:deployment#user-api',
  metadata: {
    linkedBy: 'annotation',  // or 'label', 'convention', 'explicit'
    confidence: 1.0,
  }
}
```

**Recommendation:** Yes. This enables queries like "show all links made via heuristics" for debugging.

### 9.3 Guarantee Integration

**Question:** Can Datalog guarantees reference infrastructure nodes?

**Example:**
```datalog
// Every SERVICE must have a deployment
has_deployment(S) :-
  node(S, "SERVICE", _, _),
  edge(S, D, "DEPLOYED_TO"),
  node(D, Type, _, _),
  string_concat("infra:", _, Type).

missing_deployment(S) :-
  node(S, "SERVICE", _, _),
  not has_deployment(S).
```

**Recommendation:** Yes. This is a powerful use case. Guarantees can span layers once infra nodes exist.

---

## 10. Conclusion

This revised analysis takes a fundamentally different approach:

**Old approach:** Build clever heuristics to guess code-to-infra links.
**New approach:** Build clear interfaces for developers to declare their mappings.

This aligns with Grafema's philosophy: developers know their systems better than any heuristic. Grafema provides the infrastructure (graph model, plugin system, query language), developers provide the domain knowledge.

**Recommended next steps:**

1. **Create REG-XXX:** "Infrastructure Plugin Framework" - Phase 1 deliverables
2. **Create REG-XXX:** "K8sYamlAnalyzer Reference Implementation"
3. **Defer identity resolution spike** - not needed with this approach
4. **Update REG-38 scope** to match this analysis

---

## Sources

- [Plugin Architecture Design Pattern - Dev Leader](https://www.devleader.ca/2023/09/07/plugin-architecture-design-pattern-a-beginners-guide-to-modularity/)
- [Best Practices for Decoupling Software Using Plugins - ArjanCodes](https://arjancodes.com/blog/best-practices-for-decoupling-software-using-plugins/)
- [Plug-in Architecture - OmarElgabry's Blog](https://medium.com/omarelgabrys-blog/plug-in-architecture-dec207291800)
- [Backstage - Extending the Model](https://backstage.io/docs/features/software-catalog/extending-the-model/)
- [Backstage - Catalog Customization](https://backstage.io/docs/features/software-catalog/catalog-customization/)
- [How to customize Backstage Kinds and Types - Roadie](https://roadie.io/blog/kinds-and-types-in-backstage/)
- [PMD - Extensible Static Code Analyzer](https://pmd.github.io/)
- [Dart Analyzer Plugins](https://dart.dev/tools/analyzer-plugins)
- [kube-score - Kubernetes Object Analysis](https://github.com/zegl/kube-score)
- [KubeLinter - Static Analysis for Kubernetes](https://github.com/stackrox/kube-linter)
- [Microsoft API Guidelines - Namespace Patterns](https://github.com/microsoft/api-guidelines/blob/vNext/graph/patterns/namespace.md)
- [OpenLineage - What's in a Namespace?](https://openlineage.io/blog/whats-in-a-namespace/)
