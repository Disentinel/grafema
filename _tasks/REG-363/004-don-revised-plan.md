# REG-363: USG Phase 1 — Revised Architecture Plan

**Date:** 2026-02-15
**Author:** Don Melton (Tech Lead)
**Workflow:** v2.1
**Version:** 2.0 (Fundamental Redesign)

---

## Research Summary

I researched how Backstage, Port, Cortex, OpsLevel, Crossplane, and Pulumi categorize infrastructure resources, and how developers actually ask questions about deployed systems.

### Key Findings

**1. Internal Developer Portal Taxonomy ([Port vs. Cortex](https://www.opslevel.com/resources/port-vs-cortex-whats-the-best-internal-developer-portal), [Backstage System Model](https://backstage.io/docs/features/software-catalog/system-model/))**

All major IDPs converge on similar resource categories:
- **Compute** — services, functions, containers, VMs
- **Networking** — load balancers, ingress, API gateways, service mesh
- **Storage** — databases, object stores, volumes, caches
- **Messaging** — queues, topics, event buses, streams
- **Configuration** — ConfigMaps, Secrets, environment variables, feature flags
- **Observability** — metrics, logs, traces, alerts, dashboards, SLOs

**Key insight:** Abstraction happens at the **capability level**, not tool level. AWS Lambda + GCP Cloud Function both provide "Serverless Compute" capability.

**2. Cloud-Agnostic Abstractions ([Crossplane](https://www.pulumi.com/docs/iac/comparisons/crossplane/), [Pulumi](https://medium.com/kotaicode/comparing-terraform-pulumi-and-crossplane-a-comprehensive-guide-to-infrastructure-as-code-tools-3841b783eeb0))**

Crossplane uses **Compositions** to create cloud-agnostic APIs. A `Database` composition can map to:
- AWS RDS
- GCP Cloud SQL
- Azure Database
- Self-hosted PostgreSQL

Pulumi's multi-language approach shows abstractions work best when they expose **common metadata fields** (region, instance type, scaling config) while allowing tool-specific extensions.

**3. Developer Questions ([Microservices Deployment](https://www.osohq.com/learn/microservices-deployment), [AWS DevOps](https://razorops.com/blog/most-popular-devops-questions-and-answers))**

Real questions developers ask:
- "Where is `user-service` deployed?" (Code → Compute)
- "What happens if the `payment-queue` goes down?" (Code → Messaging)
- "Who has access to the prod database?" (Code → Storage + Config)
- "What alerts cover the checkout flow?" (Code → Observability)
- "Which services use this shared cache?" (Storage → Code)
- "What's the blast radius if this Lambda fails?" (Compute → Code)

**Key insight:** Questions are **bidirectional** (code → infra AND infra → code) and **capability-focused** ("what queue" not "what SQS").

---

## Critical Gap: Original Plan Violates RoutingMap Pattern

### The Problem

Original plan (REG-363 v1) proposed:
- Tool-specific node types: `infra:k8s:deployment`, `cloud:aws:lambda`, `obs:prometheus:rule`
- Direct cross-layer edges: `SERVICE --DEPLOYED_TO--> infra:k8s:deployment`
- No abstraction layer

This **violates the proven RoutingMap pattern** used successfully in HTTP routing:

| Routing Pattern (PROVEN) | Infrastructure Pattern (PROPOSED) | Why It's Wrong |
|--------------------------|-----------------------------------|----------------|
| Abstract nodes: `http:route`, `http:request` | Tool-specific nodes: `infra:k8s:deployment` | Couples code to tools |
| Resource: RoutingMap (transforms URLs) | No resource layer | No transformation logic |
| Enrichers use abstractions | Direct edges from code to tools | Tight coupling |
| Multiple analyzers → same abstractions | K8s/Terraform → different node types | Can't swap tools |

**Root cause:** I designed infrastructure like "just another analyzer" instead of recognizing it as **multi-layer graph requiring abstraction**.

---

## Revised Architecture: Apply RoutingMap Pattern

### Three-Layer Pattern

```
LAYER 1: Abstract Resource Types (framework-agnostic)
   ↑ populated by ↓
LAYER 2: ResourceMaps (in-memory transformation/lookup)
   ↑ populated by ↓
LAYER 3: Concrete Analyzers (tool-specific parsing)
```

**Example:**

```
compute:serverless:function ← abstract node type
   ↑ created by
InfraResourceMap ← maps tool-specific → abstract
   ↑ populated by
[LambdaAnalyzer, GCPFunctionAnalyzer, AzureFunctionAnalyzer] ← concrete
```

---

## Abstract Resource Taxonomy

Based on research, here are the **abstract resource types** that tools map to:

### 1. Compute Resources

| Abstract Type | Maps To (Examples) | Metadata Fields |
|---------------|-------------------|-----------------|
| `compute:service` | K8s Deployment, ECS Service, Docker service | replicas, image, ports |
| `compute:serverless` | AWS Lambda, GCP Cloud Function, Azure Function | runtime, memory, timeout |
| `compute:job` | K8s CronJob, AWS Batch, GCP Cloud Scheduler | schedule, retries |
| `compute:vm` | EC2, GCE, Azure VM | instance_type, region |

### 2. Networking Resources

| Abstract Type | Maps To (Examples) | Metadata Fields |
|---------------|-------------------|-----------------|
| `network:ingress` | K8s Ingress, ALB, NGINX config, API Gateway | host, path, tls |
| `network:service` | K8s Service, ELB, Cloud Load Balancer | ports, protocol |
| `network:gateway` | API Gateway, Kong, Istio Gateway | routes, auth |

### 3. Storage Resources

| Abstract Type | Maps To (Examples) | Metadata Fields |
|---------------|-------------------|-----------------|
| `storage:database` | RDS, Cloud SQL, PostgreSQL, MongoDB | engine, version, size |
| `storage:object` | S3, GCS, Azure Blob | bucket, region, lifecycle |
| `storage:volume` | K8s PV, EBS, Persistent Disk | size, access_mode |
| `storage:cache` | Redis, Memcached, ElastiCache | memory, eviction_policy |

### 4. Messaging Resources

| Abstract Type | Maps To (Examples) | Metadata Fields |
|---------------|-------------------|-----------------|
| `messaging:queue` | SQS, Pub/Sub, RabbitMQ, Kafka topic | retention, dlq |
| `messaging:stream` | Kinesis, Kafka stream, Event Hub | partitions, retention |
| `messaging:topic` | SNS, Pub/Sub topic, EventBridge | subscribers |

### 5. Configuration Resources

| Abstract Type | Maps To (Examples) | Metadata Fields |
|---------------|-------------------|-----------------|
| `config:map` | K8s ConfigMap, AWS Parameter Store, env vars | keys, mounted_path |
| `config:secret` | K8s Secret, AWS Secrets Manager, Vault | keys, rotation |

### 6. Observability Resources

| Abstract Type | Maps To (Examples) | Metadata Fields |
|---------------|-------------------|-----------------|
| `observability:alert` | Prometheus AlertRule, CloudWatch Alarm, Datadog Monitor | severity, threshold, channels |
| `observability:dashboard` | Grafana, CloudWatch Dashboard, Datadog Dashboard | panels, refresh |
| `observability:slo` | SLO definition (any tool) | target, window, error_budget |
| `observability:log_target` | CloudWatch Log Group, Stackdriver, Splunk | retention, query_syntax |

---

## InfraResourceMap Design

### Interface

```typescript
/**
 * Maps concrete infrastructure resources to abstract types.
 * Similar to RoutingMap but for resource identity resolution.
 */
interface InfraResourceMap {
  id: 'infra:resource:map';

  /**
   * Register a concrete resource and its abstract type.
   *
   * @example
   * map.register({
   *   concreteId: 'infra:k8s:deployment:user-api',
   *   concreteType: 'infra:k8s:deployment',
   *   abstractType: 'compute:service',
   *   abstractId: 'compute:service:user-api',
   *   metadata: { replicas: 3, image: 'user-api:v1.2.3' },
   *   env: 'prod',
   *   sourceFile: 'k8s/prod/user-api.yaml',
   *   sourceTool: 'kubernetes',
   * });
   */
  register(mapping: ResourceMapping): void;

  /**
   * Find abstract resource by name and type.
   * Returns null if not registered.
   */
  findAbstract(name: string, type: AbstractResourceType): AbstractResource | null;

  /**
   * Find all concrete resources mapped to an abstract resource.
   * Example: find all K8s Deployments that provide "user-api" service.
   */
  findConcrete(abstractId: string): ConcreteResource[];

  /**
   * Get all resources of a given abstract type.
   * Example: all compute:serverless resources (Lambda + GCP Function + Azure).
   */
  findByType(type: AbstractResourceType): AbstractResource[];

  /**
   * Filter by environment.
   * Example: prod databases only.
   */
  findByEnv(env: string): AbstractResource[];
}

interface ResourceMapping {
  concreteId: string;          // Graph node ID (infra:k8s:deployment:user-api)
  concreteType: string;         // Tool-specific type
  abstractType: AbstractResourceType;  // compute:service
  abstractId: string;           // compute:service:user-api
  metadata: Record<string, unknown>;  // Tool-agnostic metadata
  env?: string | string[];
  sourceFile: string;
  sourceTool: string;           // 'kubernetes', 'terraform', etc.
}

interface AbstractResource {
  id: string;                   // compute:service:user-api
  type: AbstractResourceType;
  name: string;                 // user-api
  env?: string | string[];
  metadata: Record<string, unknown>;
  providers: ConcreteResource[]; // All tools that provide this
}

interface ConcreteResource {
  id: string;                   // infra:k8s:deployment:user-api
  type: string;
  tool: string;
  file: string;
}

type AbstractResourceType =
  | `compute:${string}`
  | `network:${string}`
  | `storage:${string}`
  | `messaging:${string}`
  | `config:${string}`
  | `observability:${string}`;
```

---

## Concrete Analyzer → ResourceMap → Abstract Nodes

### Flow

```
1. K8sYamlAnalyzer.parseFile('k8s/prod/user-api.yaml')
   → Creates: infra:k8s:deployment:user-api (graph node)
   → Registers in InfraResourceMap:
     {
       concreteId: 'infra:k8s:deployment:user-api',
       abstractType: 'compute:service',
       abstractId: 'compute:service:user-api',
       metadata: { replicas: 3, image: 'user-api:v1.2.3', ports: [8080] },
       env: 'prod',
       tool: 'kubernetes'
     }

2. InfraResourceMap.findAbstract('user-api', 'compute:service')
   → Returns: AbstractResource with all providers (K8s + Terraform if both exist)

3. ServiceDeploymentEnricher (runs in ENRICHMENT phase)
   → Queries InfraResourceMap for abstract resources
   → Creates edges: SERVICE:user-api --DEPLOYED_TO--> compute:service:user-api
   → Also creates: compute:service:user-api --PROVISIONED_BY--> infra:k8s:deployment:user-api
```

---

## Cross-Layer Edges (Revised)

### Code → Abstract Resources

| Edge | Source | Target | Question |
|------|--------|--------|----------|
| `DEPLOYED_TO` | SERVICE | compute:service, compute:serverless | "Where is this deployed?" |
| `SCHEDULED_BY` | FUNCTION | compute:job | "When does this run?" |
| `EXPOSED_VIA` | http:route | network:ingress, network:gateway | "How is this exposed?" |
| `READS_FROM` | FUNCTION | storage:database, storage:object | "What data sources?" |
| `WRITES_TO` | FUNCTION | storage:database, storage:object | "Where persist data?" |
| `PUBLISHES_TO` | FUNCTION | messaging:queue, messaging:topic | "Where send messages?" |
| `SUBSCRIBES_TO` | FUNCTION | messaging:queue, messaging:stream | "What messages consume?" |
| `USES_CONFIG` | SERVICE | config:map | "What config?" |
| `USES_SECRET` | SERVICE | config:secret | "What secrets?" |
| `MONITORED_BY` | SERVICE | observability:alert | "What alerts?" |
| `MEASURED_BY` | http:route | observability:slo | "What SLO?" |
| `LOGS_TO` | SERVICE | observability:log_target | "Where are logs?" |

### Abstract → Concrete (Tool Mapping)

| Edge | Source | Target | Question |
|------|--------|--------|----------|
| `PROVISIONED_BY` | compute:service | infra:k8s:deployment, infra:terraform:* | "What IaC creates this?" |
| `PROVISIONED_BY` | storage:database | cloud:aws:rds, infra:terraform:* | "What tool manages this?" |

**Direction:** Always **dependent → provider**. Code depends on abstract resources. Abstract resources are provided by concrete tools.

---

## Graph Node Structure

### Concrete Nodes (Created by Analyzers)

```typescript
// K8sYamlAnalyzer creates these
{
  id: 'infra:k8s:deployment:user-api',
  type: 'infra:k8s:deployment',
  name: 'user-api',
  file: 'k8s/prod/user-api.yaml',
  line: 10,
  metadata: {
    env: 'prod',
    namespace: 'production',
    replicas: 3,
    image: 'user-api:v1.2.3',
    // Tool-specific K8s fields
  }
}
```

### Abstract Nodes (Created by Enrichers from ResourceMap)

```typescript
// ServiceDeploymentEnricher creates these
{
  id: 'compute:service:user-api',
  type: 'compute:service',
  name: 'user-api',
  file: 'k8s/prod/user-api.yaml',  // Primary source
  metadata: {
    env: 'prod',
    replicas: 3,
    image: 'user-api:v1.2.3',
    ports: [8080],
    // Tool-agnostic compute metadata only
  }
}
```

**Key:** Abstract nodes have **no tool-specific fields**. Metadata is normalized.

---

## Metadata Field Normalization

### Example: Compute Resources

| Tool | Tool-Specific | → | Abstract Metadata |
|------|---------------|---|-------------------|
| K8s Deployment | `spec.replicas`, `spec.template.spec.containers[0].image` | → | `replicas`, `image` |
| AWS Lambda | `FunctionConfiguration.Runtime`, `FunctionConfiguration.MemorySize` | → | `runtime`, `memory` |
| GCP Cloud Function | `runtime`, `availableMemoryMb` | → | `runtime`, `memory` |

### Example: Storage Resources

| Tool | Tool-Specific | → | Abstract Metadata |
|------|---------------|---|-------------------|
| AWS RDS | `Engine`, `EngineVersion`, `AllocatedStorage` | → | `engine`, `version`, `size_gb` |
| K8s PV | `spec.capacity.storage`, `spec.accessModes` | → | `size_gb`, `access_mode` |

---

## Implementation Plan (Revised)

### Phase 1: Core Framework (4-5 days)

#### 1.1 Abstract Resource Types (`packages/types/src/infrastructure.ts`)

```typescript
/**
 * Abstract resource types (tool-agnostic).
 * These are what CODE nodes link to.
 */
export type AbstractResourceType =
  // Compute
  | 'compute:service'
  | 'compute:serverless'
  | 'compute:job'
  | 'compute:vm'
  // Networking
  | 'network:ingress'
  | 'network:service'
  | 'network:gateway'
  // Storage
  | 'storage:database'
  | 'storage:object'
  | 'storage:volume'
  | 'storage:cache'
  // Messaging
  | 'messaging:queue'
  | 'messaging:stream'
  | 'messaging:topic'
  // Config
  | 'config:map'
  | 'config:secret'
  // Observability
  | 'observability:alert'
  | 'observability:dashboard'
  | 'observability:slo'
  | 'observability:log_target';

export interface AbstractResource {
  id: string;                   // compute:service:user-api
  type: AbstractResourceType;
  name: string;
  env?: string | string[];
  metadata: Record<string, unknown>;
  providers: ConcreteResource[];
}

export interface ConcreteResource {
  id: string;                   // infra:k8s:deployment:user-api
  type: string;                 // infra:k8s:deployment
  tool: string;                 // 'kubernetes'
  file: string;
}

export interface ResourceMapping {
  concreteId: string;
  concreteType: string;
  abstractType: AbstractResourceType;
  abstractId: string;
  metadata: Record<string, unknown>;
  env?: string | string[];
  sourceFile: string;
  sourceTool: string;
}
```

#### 1.2 InfraResourceMap Interface (`packages/types/src/resources.ts`)

```typescript
export const INFRA_RESOURCE_MAP_ID = 'infra:resource:map';

export interface InfraResourceMap {
  id: typeof INFRA_RESOURCE_MAP_ID;

  register(mapping: ResourceMapping): void;
  findAbstract(name: string, type: AbstractResourceType): AbstractResource | null;
  findConcrete(abstractId: string): ConcreteResource[];
  findByType(type: AbstractResourceType): AbstractResource[];
  findByEnv(env: string): AbstractResource[];
}
```

#### 1.3 InfraResourceMapImpl (`packages/core/src/resources/InfraResourceMapImpl.ts`)

Similar structure to RoutingMapImpl:
- Indexed by abstractType → name → AbstractResource
- O(1) lookup by type and name
- Aggregates multiple concrete providers into single abstract resource

#### 1.4 Edge Types (`packages/types/src/edges.ts`)

Add to EDGE_TYPE constant:

```typescript
// === CROSS-LAYER EDGES (USG) ===
// Code → Abstract Resources
DEPLOYED_TO: 'DEPLOYED_TO',
SCHEDULED_BY: 'SCHEDULED_BY',
EXPOSED_VIA: 'EXPOSED_VIA',
USES_CONFIG: 'USES_CONFIG',
USES_SECRET: 'USES_SECRET',
PUBLISHES_TO: 'PUBLISHES_TO',
SUBSCRIBES_TO: 'SUBSCRIBES_TO',
MONITORED_BY: 'MONITORED_BY',
MEASURED_BY: 'MEASURED_BY',
LOGS_TO: 'LOGS_TO',
// READS_FROM: 'READS_FROM',  // Already exists
// WRITES_TO: 'WRITES_TO',    // Already exists

// Abstract → Concrete (Tool Mapping)
PROVISIONED_BY: 'PROVISIONED_BY',
```

---

### Phase 2: InfraAnalyzer Base Class (2-3 days)

```typescript
/**
 * InfraAnalyzer — Base class for infrastructure analyzers.
 *
 * Concrete analyzers (K8s, Terraform, etc.) extend this.
 * They create CONCRETE nodes and register mappings in InfraResourceMap.
 *
 * ENRICHERS then create ABSTRACT nodes and cross-layer edges.
 */
export abstract class InfraAnalyzer extends Plugin {
  phase = 'ANALYSIS';

  /**
   * Declare concrete node types this analyzer creates.
   * Example: ['infra:k8s:deployment', 'infra:k8s:service']
   */
  abstract declareNodeTypes(): string[];

  /**
   * Declare edge types (usually none in ANALYSIS phase).
   * Cross-layer edges are created by enrichers.
   */
  abstract declareEdgeTypes(): string[];

  /**
   * Find infrastructure files.
   */
  abstract discoverFiles(context: PluginContext): Promise<string[]>;

  /**
   * Parse file into concrete resources.
   * Create graph nodes for concrete resources.
   */
  abstract parseFile(
    filePath: string,
    content: string,
    context: PluginContext
  ): Promise<void>;

  /**
   * Map concrete resource to abstract type.
   * Returns null if no mapping (resource type not supported).
   *
   * Example:
   * K8s Deployment → compute:service
   * K8s Service → network:service
   * K8s ConfigMap → config:map
   */
  abstract mapToAbstract(
    concreteNode: ConcreteInfraNode
  ): ResourceMapping | null;

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    const { graph, resources } = context;

    // Get or create InfraResourceMap
    let resourceMap = resources?.get<InfraResourceMap>(INFRA_RESOURCE_MAP_ID);
    if (!resourceMap) {
      resourceMap = new InfraResourceMapImpl();
      resources?.set(INFRA_RESOURCE_MAP_ID, resourceMap);
    }

    // Discover files
    const files = await this.discoverFiles(context);
    logger.info('Files discovered', { count: files.length });

    let nodesCreated = 0;
    let mappingsRegistered = 0;

    // Parse each file
    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf-8');

      // parseFile creates concrete nodes in graph
      await this.parseFile(filePath, content, context);
      nodesCreated++;

      // After creating nodes, query graph for newly created nodes
      // and register mappings
      const concreteNodes = await this.getCreatedNodes(graph, filePath);

      for (const node of concreteNodes) {
        const mapping = this.mapToAbstract(node);
        if (mapping) {
          resourceMap.register(mapping);
          mappingsRegistered++;
        }
      }
    }

    logger.info('Analysis complete', { nodesCreated, mappingsRegistered });
    return createSuccessResult({ nodes: nodesCreated, mappings: mappingsRegistered });
  }
}
```

---

### Phase 3: Enrichers (3-4 days)

#### 3.1 ServiceDeploymentEnricher

```typescript
/**
 * Creates abstract compute nodes and links SERVICE nodes to them.
 *
 * Phase: ENRICHMENT
 * Dependencies: InfraAnalyzer implementations (K8s, Terraform, etc.)
 */
export class ServiceDeploymentEnricher extends Plugin {
  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, resources } = context;
    const resourceMap = resources?.get<InfraResourceMap>(INFRA_RESOURCE_MAP_ID);

    if (!resourceMap) {
      // No infrastructure analyzed, skip
      return createSuccessResult();
    }

    // Find all compute resources (service, serverless, vm)
    const computeResources = [
      ...resourceMap.findByType('compute:service'),
      ...resourceMap.findByType('compute:serverless'),
      ...resourceMap.findByType('compute:vm'),
    ];

    let abstractNodesCreated = 0;
    let codeEdgesCreated = 0;
    let concreteEdgesCreated = 0;

    for (const abstractRes of computeResources) {
      // Create abstract node
      await graph.addNode({
        id: abstractRes.id,
        type: abstractRes.type,
        name: abstractRes.name,
        file: abstractRes.providers[0].file,  // Primary source
        metadata: {
          env: abstractRes.env,
          ...abstractRes.metadata,
        },
      });
      abstractNodesCreated++;

      // Link to SERVICE node (if exists)
      const serviceNode = await graph.getNode(`SERVICE:${abstractRes.name}`);
      if (serviceNode) {
        await graph.addEdge({
          src: serviceNode.id,
          dst: abstractRes.id,
          type: 'DEPLOYED_TO',
        });
        codeEdgesCreated++;
      }

      // Link to concrete provider nodes
      for (const provider of abstractRes.providers) {
        await graph.addEdge({
          src: abstractRes.id,
          dst: provider.id,
          type: 'PROVISIONED_BY',
          metadata: { tool: provider.tool },
        });
        concreteEdgesCreated++;
      }
    }

    return createSuccessResult({
      nodes: abstractNodesCreated,
      edges: codeEdgesCreated + concreteEdgesCreated,
    });
  }
}
```

#### 3.2 StorageConnectionEnricher

Links CODE → storage:database, storage:object, etc.

#### 3.3 MessagingConnectionEnricher

Links CODE → messaging:queue, messaging:topic, etc.

---

### Phase 4: Configuration Schema (1 day)

```yaml
infrastructure:
  enabled: true

  # Concrete analyzers
  kubernetes:
    enabled: true
    paths:
      - 'k8s/**/*.yaml'
    # Explicit mapping overrides (optional)
    mappings:
      deployments:
        user-api: 'apps/user-api'  # K8s deployment → SERVICE name

  terraform:
    enabled: false
    paths:
      - 'terraform/**/*.tf'
```

---

### Phase 5: Tests (2-3 days)

#### Unit Tests
- InfraResourceMapImpl (register, findAbstract, findConcrete)
- Mock analyzer registering mappings
- Enrichers creating abstract nodes and edges

#### Integration Tests
- K8s YAML → concrete nodes → ResourceMap → abstract nodes → code edges
- Multiple tools providing same abstract resource (K8s + Terraform both create compute:service)

---

## Developer Queries (Enabled by This Design)

### Query 1: Where is `user-service` deployed?

```datalog
deployment_info(Service, AbstractType, Tool, Env) :-
  node(Service, "SERVICE", "user-service", _),
  edge(Service, Abstract, "DEPLOYED_TO"),
  node(Abstract, AbstractType, _, AbstractMeta),
  edge(Abstract, Concrete, "PROVISIONED_BY"),
  node(Concrete, _, _, ConcreteMeta),
  json_get(ConcreteMeta, "tool", Tool),
  json_get(AbstractMeta, "env", Env).
```

**Result:**
```
user-service | compute:service | kubernetes | prod
user-service | compute:service | terraform  | prod
```

### Query 2: What services use the `payment-queue`?

```datalog
queue_consumers(Service, Queue) :-
  node(Queue, "messaging:queue", "payment-queue", _),
  edge(Service, Queue, "SUBSCRIBES_TO"),
  node(Service, "SERVICE", _, _).
```

### Query 3: Tool-agnostic blast radius

```datalog
// What code depends on this abstract resource?
blast_radius(Resource, DependentCode) :-
  node(Resource, Type, _, _),
  string_concat("compute:", _, Type),  // Any compute resource
  edge(DependentCode, Resource, "DEPLOYED_TO"),
  node(DependentCode, "SERVICE", _, _).
```

**Works regardless of whether compute is K8s, Lambda, or GCP Function.**

---

## Why This Design Is Right

### 1. Follows Proven Pattern

| HTTP Routing (Proven) | Infrastructure (Revised) |
|-----------------------|--------------------------|
| `http:route` (abstract) | `compute:service` (abstract) |
| RoutingMap transforms URLs | InfraResourceMap transforms tool-specific → abstract |
| ExpressAnalyzer → http:route | K8sAnalyzer → infra:k8s:* → compute:service |
| Enrichers link code → http:route | Enrichers link code → abstract resources |

### 2. Enables Tool Swapping

```
// Before migration: K8s
SERVICE:user-api --DEPLOYED_TO--> compute:service:user-api --PROVISIONED_BY--> infra:k8s:deployment:user-api

// After migration: K8s + Terraform
SERVICE:user-api --DEPLOYED_TO--> compute:service:user-api --PROVISIONED_BY--> infra:k8s:deployment:user-api
                                                             --PROVISIONED_BY--> infra:terraform:resource:user-api

// After full migration: Terraform only
SERVICE:user-api --DEPLOYED_TO--> compute:service:user-api --PROVISIONED_BY--> infra:terraform:resource:user-api
```

**Code edges stay stable.** Queries don't break.

### 3. Answers Real Developer Questions

All questions from research map to abstract types:
- "Where deployed?" → compute:*
- "What queue?" → messaging:*
- "What database?" → storage:*
- "What alerts?" → observability:*

### 4. Supports Multi-Tool Environments

Real systems use:
- K8s for compute + Terraform for cloud resources
- NGINX for ingress + K8s for services
- Prometheus for metrics + Datadog for logs

Abstract types unify them.

---

## Success Criteria (Revised)

✅ **Architecture:**
- InfraResourceMap interface defined
- InfraResourceMapImpl implements register/find operations
- Abstract resource types enumerated (20+ types across 6 categories)

✅ **Analyzers:**
- InfraAnalyzer base class with mapToAbstract contract
- Concrete analyzers create concrete nodes + register mappings

✅ **Enrichers:**
- ServiceDeploymentEnricher creates abstract nodes
- Cross-layer edges link CODE → abstract resources
- PROVISIONED_BY edges link abstract → concrete

✅ **Tests:**
- Unit tests for InfraResourceMapImpl
- Integration test: K8s YAML → abstract nodes → code edges

✅ **Documentation:**
- Abstract resource taxonomy documented
- Metadata normalization rules
- AI agent guide for writing analyzers

---

## Effort Estimate (Revised)

| Phase | Effort |
|-------|--------|
| 1. Types + ResourceMap interface | 1 day |
| 2. InfraResourceMapImpl | 1 day |
| 3. InfraAnalyzer base class | 1.5 days |
| 4. Enrichers (ServiceDeployment, Storage, Messaging) | 2 days |
| 5. Config schema | 0.5 day |
| 6. Tests | 2 days |
| 7. Documentation | 1 day |

**Total:** 9-10 days (with buffer)

**Why longer than v1?**
- ResourceMap implementation (new)
- Enrichers (not in v1)
- Abstract node creation logic
- More complex test scenarios

**Why worth it?**
- Correct architecture from day 1
- No migration needed later
- Enables tool swapping
- Matches proven pattern

---

## Next Steps (After REG-363 v2)

**REG-364: K8s Analyzer (Reference Implementation)**
- Implement K8sYamlAnalyzer extending InfraAnalyzer
- Parse K8s manifests → create concrete nodes
- Implement mapToAbstract for K8s resource types:
  - Deployment → compute:service
  - CronJob → compute:job
  - Service → network:service
  - Ingress → network:ingress
  - ConfigMap → config:map
  - Secret → config:secret
- Integration test with real K8s YAML

**REG-365: Terraform Analyzer**
- Parse .tf HCL files
- Map Terraform resources → abstract + cloud types
- Handle multi-provider (AWS, GCP, Azure)

---

## Sources

Research references:
- [Port vs. Cortex: IDP Comparison](https://www.opslevel.com/resources/port-vs-cortex-whats-the-best-internal-developer-portal)
- [Backstage Software Catalog System Model](https://backstage.io/docs/features/software-catalog/system-model/)
- [Crossplane vs Pulumi Comparison](https://medium.com/kotaicode/comparing-terraform-pulumi-and-crossplane-a-comprehensive-guide-to-infrastructure-as-code-tools-3841b783eeb0)
- [Pulumi Crossplane Integration](https://www.pulumi.com/docs/iac/comparisons/crossplane/)
- [Microservices Deployment Patterns](https://www.osohq.com/learn/microservices-deployment)
- [DevOps Common Questions](https://razorops.com/blog/most-popular-devops-questions-and-answers)
- [Infrastructure Observability](https://www.virtana.com/guides/ipm-guide/infrastructure-observability/)
