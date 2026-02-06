# REG-38: Cross-Layer Edge Types Design

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-06
**Status:** Design Specification

---

## Executive Summary

This document defines the cross-layer edge types for the Universal System Graph (USG), designed around real software development lifecycle (SDLC) operations. The design is grounded in prior art from industry tools and addresses concrete developer questions.

**Key principles:**
1. **Operation-driven design** - Each edge type answers a specific SDLC question
2. **Verb-based naming** - Direction matters, names describe relationships
3. **Consistent direction** - Subject points to object (dependent -> provider)
4. **Minimal but complete** - Cover real operations, avoid hypothetical edges

---

## 1. Research Findings

### 1.1 Industry Prior Art

#### Backstage Software Catalog Relations
Source: [Backstage Well-known Relations](https://backstage.io/docs/features/software-catalog/well-known-relations/)

Backstage defines directional relation pairs:
- `ownedBy` / `ownerOf` - Ownership relations
- `providesApi` / `apiProvidedBy` - API exposure
- `consumesApi` / `apiConsumedBy` - API consumption
- `dependsOn` / `dependencyOf` - General dependency

**Key insight:** Relations are directional pairs. The source entity "has" the relation to the target entity.

#### OpenTelemetry Semantic Conventions
Source: [OpenTelemetry Trace Conventions](https://opentelemetry.io/docs/specs/semconv/general/trace/)

OTel defines span relationships via `SpanKind`:
- `SERVER` / `CLIENT` - Request-response pairs
- `PRODUCER` / `CONSUMER` - Async message patterns
- `INTERNAL` - Non-boundary operations

**Key insight:** Relationships capture communication patterns (sync vs async, request vs event).

#### AWS X-Ray Service Map
Source: [AWS X-Ray Concepts](https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html)

X-Ray edges capture:
- Standard edges (solid lines) - Synchronous calls between services
- Dashed edges - Async/event-driven relationships (SQS -> Lambda)
- Edge data includes latency, error rates from client perspective

**Key insight:** Edge metadata captures operational characteristics (latency, errors, async vs sync).

#### Envoy/Istio Service Mesh
Source: [Istio Traffic Management](https://istio.io/latest/docs/concepts/traffic-management/)

Service mesh terminology:
- **Upstream** - Service being called (backend)
- **Downstream** - Service initiating call (frontend)
- **Cluster** - Logical grouping of endpoints

**Key insight:** Direction convention - traffic flows downstream->upstream.

### 1.2 Real SDLC Operations Analysis

I analyzed what operations developers perform that cross code/infrastructure boundaries:

| Phase | Operation | Code/Infra Crossing |
|-------|-----------|-------------------|
| **Development** | Debug locally | Code -> Docker Compose -> env vars |
| **Development** | Profile | Code -> metrics endpoint -> dashboard |
| **Testing** | Integration test | Code -> test fixtures -> K8s Service |
| **Testing** | E2E test | Test code -> API endpoint -> K8s Ingress |
| **Deployment** | CI/CD | Code commit -> build artifact -> K8s Deployment |
| **Deployment** | Rollout | K8s Deployment -> ReplicaSet -> Pod |
| **Support** | Incident | Alert -> K8s Service -> Code handler |
| **Support** | Log analysis | Log entry -> trace ID -> Code function |
| **Support** | Capacity | SLO -> K8s HPA -> Code scaling logic |

### 1.3 Common Developer Questions

Questions requiring cross-layer knowledge:

| Question | Required Traversal |
|----------|-------------------|
| "Which service handles this endpoint?" | `http:route` -> handler FUNCTION -> SERVICE |
| "What config does this function use?" | FUNCTION -> CONFIGURED_BY -> `infra:k8s:configmap` |
| "Where is this deployed?" | SERVICE -> DEPLOYED_TO -> `infra:k8s:deployment` |
| "What alerts fire if this fails?" | SERVICE -> MONITORED_BY -> `obs:prometheus:rule` |
| "Who owns this infrastructure?" | `infra:k8s:deployment` -> OWNED_BY -> team metadata |
| "What cloud resources does this use?" | FUNCTION -> USES_RESOURCE -> `cloud:aws:sqs` |
| "What happens if this queue is down?" | `cloud:aws:sqs` <- SUBSCRIBES_TO <- FUNCTION |

---

## 2. Edge Type Catalog

### 2.1 Design Principles

**Naming Convention:**
- Verb-based, past/present tense as appropriate
- Direction: subject `--VERB-->` object
- Active voice: "X DEPLOYS_TO Y" not "Y HAS_DEPLOYMENT X"

**Direction Convention:**
```
Code Entity -----> Infrastructure Entity -----> Cloud Entity
     |                    |
     v                    v
Observability Entity <----+
```

The "dependent" entity points to the "provider" entity:
- Code DEPLOYED_TO infrastructure (code depends on being deployed)
- Infrastructure PROVISIONS cloud (infra creates cloud resources)
- Entity MONITORED_BY observability (entity is watched by monitoring)

### 2.2 Code <-> Infrastructure Edges

These edges connect code entities (SERVICE, FUNCTION, etc.) to infrastructure entities (`infra:*`).

#### DEPLOYED_TO

**Purpose:** Links code component to its infrastructure deployment target.

| Property | Value |
|----------|-------|
| Source | `SERVICE`, `FUNCTION` |
| Target | `infra:k8s:deployment`, `infra:k8s:statefulset`, `infra:docker:service`, `infra:ecs:service` |
| Question Answered | "Where is this code deployed?" |
| Reverse Query | "What code runs in this deployment?" |

**Example:**
```
SERVICE#user-api --DEPLOYED_TO--> infra:k8s:deployment#user-api
```

**Metadata:**
```typescript
interface DeployedToMetadata {
  linkedBy: 'annotation' | 'label' | 'convention' | 'explicit';
  environment?: string[];  // ['prod', 'staging'] or undefined for all
}
```

#### CONFIGURED_BY

**Purpose:** Links code component to its configuration source.

| Property | Value |
|----------|-------|
| Source | `SERVICE`, `FUNCTION`, `VARIABLE` |
| Target | `infra:k8s:configmap`, `infra:k8s:secret`, `infra:terraform:local` |
| Question Answered | "Where does this code get its configuration?" |
| Reverse Query | "What code uses this config?" |

**Example:**
```
SERVICE#payment-service --CONFIGURED_BY--> infra:k8s:configmap#payment-config
```

**Metadata:**
```typescript
interface ConfiguredByMetadata {
  configKeys?: string[];  // Which keys are used, if known
  mountPath?: string;     // Where config is mounted
}
```

#### USES_SECRET

**Purpose:** Links code to secrets/credentials it consumes.

| Property | Value |
|----------|-------|
| Source | `SERVICE`, `FUNCTION`, `VARIABLE` |
| Target | `infra:k8s:secret`, `cloud:aws:secretsmanager`, `cloud:vault:secret` |
| Question Answered | "What secrets does this code need?" |
| Reverse Query | "What code has access to this secret?" |

**Example:**
```
SERVICE#payment-service --USES_SECRET--> infra:k8s:secret#stripe-api-key
```

**Metadata:**
```typescript
interface UsesSecretMetadata {
  secretKey?: string;   // Which key in the secret
  envVarName?: string;  // Environment variable name
}
```

#### EXPOSED_VIA

**Purpose:** Links code endpoint to its network exposure.

| Property | Value |
|----------|-------|
| Source | `http:route`, `SERVICE` |
| Target | `infra:k8s:service`, `infra:k8s:ingress`, `cloud:aws:alb` |
| Question Answered | "How is this endpoint exposed to network?" |
| Reverse Query | "What code is behind this ingress?" |

**Example:**
```
http:route#POST/api/orders --EXPOSED_VIA--> infra:k8s:ingress#api-gateway
```

**Metadata:**
```typescript
interface ExposedViaMetadata {
  port?: number;
  protocol?: 'http' | 'https' | 'grpc' | 'tcp';
  hostPattern?: string;  // e.g., "api.example.com"
}
```

#### SCHEDULED_BY

**Purpose:** Links code to its scheduling infrastructure.

| Property | Value |
|----------|-------|
| Source | `FUNCTION`, `SERVICE` |
| Target | `infra:k8s:cronjob`, `cloud:aws:eventbridge:rule`, `cloud:aws:cloudwatch:rule` |
| Question Answered | "When does this code run?" |
| Reverse Query | "What code does this schedule trigger?" |

**Example:**
```
FUNCTION#cleanupExpiredSessions --SCHEDULED_BY--> infra:k8s:cronjob#session-cleanup
```

**Metadata:**
```typescript
interface ScheduledByMetadata {
  schedule?: string;  // Cron expression
  timezone?: string;
}
```

### 2.3 Infrastructure <-> Infrastructure Edges

These edges connect infrastructure entities within or across tools.

#### EXPOSES (existing, extended)

**Purpose:** Links workload to its service abstraction.

| Property | Value |
|----------|-------|
| Source | `infra:k8s:deployment`, `infra:k8s:statefulset` |
| Target | `infra:k8s:service` |
| Question Answered | "What K8s Service exposes this Deployment?" |

**Example:**
```
infra:k8s:deployment#user-api --EXPOSES--> infra:k8s:service#user-api-svc
```

#### ROUTES_TO (existing, extended)

**Purpose:** Links ingress/gateway to backend service.

| Property | Value |
|----------|-------|
| Source | `infra:k8s:ingress`, `infra:k8s:gateway`, `cloud:aws:alb` |
| Target | `infra:k8s:service`, `infra:k8s:deployment` |
| Question Answered | "Where does this ingress route traffic?" |

**Example:**
```
infra:k8s:ingress#main-gateway --ROUTES_TO--> infra:k8s:service#user-api-svc
```

**Metadata:**
```typescript
interface RoutesToMetadata {
  pathPattern?: string;   // e.g., "/api/users/*"
  hostPattern?: string;
  weight?: number;        // For traffic splitting
}
```

#### DEPENDS_ON (existing, extended)

**Purpose:** General infrastructure dependency.

| Property | Value |
|----------|-------|
| Source | Any `infra:*` node |
| Target | Any `infra:*` node |
| Question Answered | "What must exist before this resource?" |

**Example:**
```
infra:terraform:resource#lambda_function --DEPENDS_ON--> infra:terraform:resource#iam_role
```

#### MOUNTS_VOLUME

**Purpose:** Links workload to its storage.

| Property | Value |
|----------|-------|
| Source | `infra:k8s:deployment`, `infra:k8s:statefulset`, `infra:docker:service` |
| Target | `infra:k8s:pvc`, `infra:k8s:configmap`, `infra:docker:volume` |
| Question Answered | "What storage does this workload use?" |

**Example:**
```
infra:k8s:deployment#postgres --MOUNTS_VOLUME--> infra:k8s:pvc#postgres-data
```

**Metadata:**
```typescript
interface MountsVolumeMetadata {
  mountPath: string;
  readOnly?: boolean;
}
```

### 2.4 Infrastructure <-> Cloud Edges

These edges connect IaC definitions to cloud provider resources.

#### PROVISIONS

**Purpose:** Links IaC resource definition to cloud resource it creates.

| Property | Value |
|----------|-------|
| Source | `infra:terraform:resource`, `infra:cloudformation:resource`, `infra:pulumi:resource` |
| Target | `cloud:aws:*`, `cloud:gcp:*`, `cloud:azure:*` |
| Question Answered | "What cloud resource does this IaC create?" |
| Reverse Query | "How is this cloud resource defined?" |

**Example:**
```
infra:terraform:resource#aws_sqs_queue.orders --PROVISIONS--> cloud:aws:sqs#orders-queue
```

**Metadata:**
```typescript
interface ProvisionsMetadata {
  resourceArn?: string;   // If known from state
  region?: string;
  account?: string;
}
```

#### TARGETS

**Purpose:** Links K8s workload to cloud-managed compute (EKS, ECS, etc.).

| Property | Value |
|----------|-------|
| Source | `infra:k8s:deployment`, `infra:helm:release` |
| Target | `cloud:aws:eks:cluster`, `cloud:gcp:gke:cluster`, `cloud:azure:aks:cluster` |
| Question Answered | "What cluster does this run on?" |

**Example:**
```
infra:k8s:deployment#user-api --TARGETS--> cloud:aws:eks:cluster#production
```

### 2.5 Code <-> Cloud Edges

These edges connect code directly to cloud services it interacts with.

#### PUBLISHES_TO

**Purpose:** Links code that sends messages to a queue/topic.

| Property | Value |
|----------|-------|
| Source | `FUNCTION`, `CALL` |
| Target | `cloud:aws:sqs`, `cloud:aws:sns`, `cloud:gcp:pubsub:topic`, `cloud:azure:servicebus` |
| Question Answered | "Where does this code send messages?" |
| Reverse Query | "What code publishes to this queue?" |

**Example:**
```
FUNCTION#createOrder --PUBLISHES_TO--> cloud:aws:sqs#orders-queue
```

**Metadata:**
```typescript
interface PublishesToMetadata {
  messageType?: string;    // Schema/type of messages
  fifo?: boolean;
  deduplicationId?: string;
}
```

#### SUBSCRIBES_TO

**Purpose:** Links code that receives messages from a queue/topic.

| Property | Value |
|----------|-------|
| Source | `FUNCTION`, `SERVICE` |
| Target | `cloud:aws:sqs`, `cloud:aws:sns`, `cloud:gcp:pubsub:subscription`, `cloud:azure:servicebus` |
| Question Answered | "Where does this code receive messages from?" |
| Reverse Query | "What code processes this queue?" |

**Example:**
```
FUNCTION#processOrder --SUBSCRIBES_TO--> cloud:aws:sqs#orders-queue
```

**Metadata:**
```typescript
interface SubscribesToMetadata {
  batchSize?: number;
  visibilityTimeout?: number;
  dlq?: string;  // Dead letter queue reference
}
```

#### STORES_IN

**Purpose:** Links code that writes to storage.

| Property | Value |
|----------|-------|
| Source | `FUNCTION`, `CALL` |
| Target | `cloud:aws:s3`, `cloud:aws:dynamodb`, `cloud:gcp:storage`, `cloud:gcp:firestore` |
| Question Answered | "Where does this code persist data?" |

**Example:**
```
FUNCTION#uploadAvatar --STORES_IN--> cloud:aws:s3#user-avatars
```

**Metadata:**
```typescript
interface StoresInMetadata {
  operation?: 'read' | 'write' | 'both';
  keyPattern?: string;  // e.g., "users/{userId}/avatar"
}
```

#### READS_FROM (new, for cloud resources)

**Purpose:** Links code that reads from cloud storage/data.

| Property | Value |
|----------|-------|
| Source | `FUNCTION`, `CALL` |
| Target | `cloud:aws:s3`, `cloud:aws:dynamodb`, `cloud:aws:secretsmanager` |
| Question Answered | "Where does this code read data from?" |

**Example:**
```
FUNCTION#getAvatar --READS_FROM--> cloud:aws:s3#user-avatars
```

#### INVOKES_FUNCTION

**Purpose:** Links code that calls serverless functions.

| Property | Value |
|----------|-------|
| Source | `FUNCTION`, `CALL` |
| Target | `cloud:aws:lambda`, `cloud:gcp:function`, `cloud:azure:function` |
| Question Answered | "What serverless functions does this code trigger?" |

**Example:**
```
FUNCTION#processWebhook --INVOKES_FUNCTION--> cloud:aws:lambda#imageProcessor
```

**Metadata:**
```typescript
interface InvokesFunctionMetadata {
  invocationType?: 'sync' | 'async' | 'event';
}
```

### 2.6 Code/Infrastructure <-> Observability Edges

These edges connect entities to their monitoring and alerting.

#### MONITORED_BY

**Purpose:** Links entity to its monitoring rule/alert.

| Property | Value |
|----------|-------|
| Source | `SERVICE`, `http:route`, `infra:k8s:deployment`, `cloud:*` |
| Target | `obs:prometheus:rule`, `obs:datadog:monitor`, `obs:cloudwatch:alarm` |
| Question Answered | "What alerts watch this component?" |
| Reverse Query | "What does this alert monitor?" |

**Example:**
```
SERVICE#payment-service --MONITORED_BY--> obs:prometheus:rule#payment-error-rate
```

**Metadata:**
```typescript
interface MonitoredByMetadata {
  severity?: 'critical' | 'warning' | 'info';
  threshold?: string;     // e.g., "error_rate > 0.01"
  notificationChannel?: string;
}
```

#### MEASURED_BY

**Purpose:** Links entity to SLO/SLI definition.

| Property | Value |
|----------|-------|
| Source | `SERVICE`, `http:route` |
| Target | `obs:slo`, `obs:sli` |
| Question Answered | "What SLO covers this component?" |

**Example:**
```
http:route#POST/api/orders --MEASURED_BY--> obs:slo#orders-availability
```

**Metadata:**
```typescript
interface MeasuredByMetadata {
  target?: number;    // e.g., 0.999
  window?: string;    // e.g., "30d"
}
```

#### VISUALIZED_IN

**Purpose:** Links entity to dashboard that displays it.

| Property | Value |
|----------|-------|
| Source | `SERVICE`, `infra:k8s:deployment`, `cloud:*` |
| Target | `obs:grafana:dashboard`, `obs:datadog:dashboard` |
| Question Answered | "Where can I see this component's metrics?" |

**Example:**
```
SERVICE#user-api --VISUALIZED_IN--> obs:grafana:dashboard#api-overview
```

#### LOGS_TO

**Purpose:** Links entity to its log destination.

| Property | Value |
|----------|-------|
| Source | `SERVICE`, `infra:k8s:deployment` |
| Target | `obs:loki:stream`, `obs:elasticsearch:index`, `cloud:aws:cloudwatch:loggroup` |
| Question Answered | "Where are this component's logs?" |

**Example:**
```
SERVICE#user-api --LOGS_TO--> cloud:aws:cloudwatch:loggroup#/app/user-api
```

### 2.7 Intra-Layer Edges (Within Same Layer)

Some edges connect nodes within the same layer.

#### CALLS_SERVICE (Code layer)

**Purpose:** Links service-to-service calls within code.

| Property | Value |
|----------|-------|
| Source | `SERVICE`, `FUNCTION` |
| Target | `SERVICE` |
| Question Answered | "What other services does this code call?" |

**Example:**
```
SERVICE#order-service --CALLS_SERVICE--> SERVICE#inventory-service
```

**Metadata:**
```typescript
interface CallsServiceMetadata {
  protocol?: 'http' | 'grpc' | 'graphql';
  endpoints?: string[];  // Which endpoints are called
}
```

#### INHERITS_FROM (Infrastructure layer)

**Purpose:** Links Helm releases to parent charts.

| Property | Value |
|----------|-------|
| Source | `infra:helm:release` |
| Target | `infra:helm:chart` |
| Question Answered | "What chart is this release based on?" |

**Example:**
```
infra:helm:release#user-api-prod --INHERITS_FROM--> infra:helm:chart#microservice-base
```

---

## 3. Environment Metadata Design

### 3.1 Requirements

Based on user clarification:
- Environment is **optional metadata** on nodes
- Used for **query filtering**, not graph structure
- No filter = show all paths
- With filter `env: prod` = only prod-related nodes

### 3.2 Schema

```typescript
interface EnvironmentMetadata {
  /**
   * Environment(s) this node belongs to.
   *
   * - undefined: Node exists in all environments (environment-agnostic)
   * - string: Single environment
   * - string[]: Multiple environments (e.g., staging and prod share same config)
   *
   * @example
   * // Code nodes are typically environment-agnostic
   * { env: undefined }
   *
   * // K8s deployment specific to prod
   * { env: 'prod' }
   *
   * // Shared staging/preview config
   * { env: ['staging', 'preview'] }
   */
  env?: string | string[];
}
```

### 3.3 Which Nodes Have Environment Metadata

| Node Category | Has `env`? | Rationale |
|---------------|------------|-----------|
| Code nodes (`SERVICE`, `FUNCTION`, etc.) | Rarely | Same code deployed to multiple envs |
| Infrastructure nodes (`infra:k8s:*`) | Yes | Each env has different K8s manifests |
| Cloud nodes (`cloud:*`) | Yes | Each env has different cloud resources |
| Observability nodes (`obs:*`) | Yes | Different alert thresholds per env |

**Exception:** When code is environment-specific (e.g., feature flags), it CAN have `env` metadata.

### 3.4 Query Filtering Examples

**Show all paths (no filter):**
```datalog
// Find all routes and their handlers
path(Route, Handler) :-
  node(Route, "http:route", _, _),
  edge(Route, Handler, "HANDLED_BY").
```

**Filter by environment:**
```datalog
// Find prod deployments
prod_deployments(D) :-
  node(D, Type, _, Metadata),
  string_concat("infra:k8s:", _, Type),
  json_get(Metadata, "env", Env),
  (Env = "prod" ; member("prod", Env)).

// Find routes exposed in prod
prod_routes(Route) :-
  node(Route, "http:route", _, _),
  path(Route, Service),
  node(Service, "SERVICE", _, _),
  edge(Service, Deployment, "DEPLOYED_TO"),
  prod_deployments(Deployment).
```

**Cross-environment comparison:**
```datalog
// Services deployed to staging but not prod
staging_only(S) :-
  node(S, "SERVICE", Name, _),
  edge(S, StagingDep, "DEPLOYED_TO"),
  node(StagingDep, _, _, StagingMeta),
  json_get(StagingMeta, "env", "staging"),
  not(
    edge(S, ProdDep, "DEPLOYED_TO"),
    node(ProdDep, _, _, ProdMeta),
    json_get(ProdMeta, "env", "prod")
  ).
```

### 3.5 Environment Discovery

Analyzers determine environment from:

1. **Explicit annotation:**
   ```yaml
   metadata:
     annotations:
       grafema.io/env: prod
   ```

2. **Namespace convention:**
   ```typescript
   // If namespace ends with -prod, -staging, etc.
   const env = namespace.match(/-(\w+)$/)?.[1];
   ```

3. **File path convention:**
   ```typescript
   // If file is in k8s/prod/, k8s/staging/, etc.
   const env = filePath.match(/\/k8s\/(\w+)\//)?.[1];
   ```

4. **Configuration:**
   ```yaml
   # grafema.config.yaml
   infrastructure:
     environments:
       - name: prod
         pathPattern: '**/prod/**'
         namespacePattern: '*-prod'
       - name: staging
         pathPattern: '**/staging/**'
         namespacePattern: '*-staging'
   ```

---

## 4. Complete Edge Type Summary

### 4.1 Edge Type Table

| Edge Type | Source Layer | Target Layer | Direction |
|-----------|--------------|--------------|-----------|
| `DEPLOYED_TO` | Code | Infra | Code -> Infra |
| `CONFIGURED_BY` | Code | Infra | Code -> Infra |
| `USES_SECRET` | Code | Infra/Cloud | Code -> Infra |
| `EXPOSED_VIA` | Code | Infra | Code -> Infra |
| `SCHEDULED_BY` | Code | Infra/Cloud | Code -> Infra |
| `EXPOSES` | Infra | Infra | Infra -> Infra |
| `ROUTES_TO` | Infra | Infra | Infra -> Infra |
| `DEPENDS_ON` | Infra | Infra | Infra -> Infra |
| `MOUNTS_VOLUME` | Infra | Infra | Infra -> Infra |
| `PROVISIONS` | Infra | Cloud | Infra -> Cloud |
| `TARGETS` | Infra | Cloud | Infra -> Cloud |
| `PUBLISHES_TO` | Code | Cloud | Code -> Cloud |
| `SUBSCRIBES_TO` | Code | Cloud | Code -> Cloud |
| `STORES_IN` | Code | Cloud | Code -> Cloud |
| `READS_FROM` | Code | Cloud | Code -> Cloud |
| `INVOKES_FUNCTION` | Code | Cloud | Code -> Cloud |
| `MONITORED_BY` | Code/Infra | Obs | Any -> Obs |
| `MEASURED_BY` | Code | Obs | Code -> Obs |
| `VISUALIZED_IN` | Code/Infra | Obs | Any -> Obs |
| `LOGS_TO` | Code/Infra | Obs/Cloud | Any -> Obs |
| `CALLS_SERVICE` | Code | Code | Code -> Code |
| `INHERITS_FROM` | Infra | Infra | Infra -> Infra |

### 4.2 TypeScript Definition

```typescript
/**
 * Cross-layer edge types for Universal System Graph.
 *
 * Naming convention:
 * - Verb-based (DEPLOYED_TO, not HAS_DEPLOYMENT)
 * - Direction: subject VERB target
 * - Dependent points to provider
 */
export const CROSS_LAYER_EDGE_TYPE = {
  // Code <-> Infrastructure
  DEPLOYED_TO: 'DEPLOYED_TO',
  CONFIGURED_BY: 'CONFIGURED_BY',
  USES_SECRET: 'USES_SECRET',
  EXPOSED_VIA: 'EXPOSED_VIA',
  SCHEDULED_BY: 'SCHEDULED_BY',

  // Infrastructure <-> Infrastructure (extending existing)
  // EXPOSES - already exists
  // ROUTES_TO - already exists
  // DEPENDS_ON - already exists
  MOUNTS_VOLUME: 'MOUNTS_VOLUME',
  INHERITS_FROM: 'INHERITS_FROM',

  // Infrastructure <-> Cloud
  PROVISIONS: 'PROVISIONS',
  TARGETS: 'TARGETS',

  // Code <-> Cloud
  PUBLISHES_TO: 'PUBLISHES_TO',
  SUBSCRIBES_TO: 'SUBSCRIBES_TO',
  STORES_IN: 'STORES_IN',
  READS_FROM: 'READS_FROM',
  INVOKES_FUNCTION: 'INVOKES_FUNCTION',

  // Any <-> Observability
  MONITORED_BY: 'MONITORED_BY',
  MEASURED_BY: 'MEASURED_BY',
  VISUALIZED_IN: 'VISUALIZED_IN',
  LOGS_TO: 'LOGS_TO',

  // Intra-layer
  CALLS_SERVICE: 'CALLS_SERVICE',
} as const;

export type CrossLayerEdgeType = typeof CROSS_LAYER_EDGE_TYPE[keyof typeof CROSS_LAYER_EDGE_TYPE];
```

---

## 5. Example Queries

### 5.1 Deployment Tracing

**Question:** "Show me everything about the user-api service deployment"

```datalog
// Find service and all its deployments across environments
service_deployment(Service, Deployment, Env) :-
  node(Service, "SERVICE", "user-api", _),
  edge(Service, Deployment, "DEPLOYED_TO"),
  node(Deployment, Type, _, Meta),
  string_concat("infra:k8s:", _, Type),
  (json_get(Meta, "env", Env) ; Env = "all").
```

### 5.2 Incident Response

**Question:** "The orders queue is backed up - what code processes it?"

```datalog
// Find all code that subscribes to orders queue
queue_processors(Func, QueueName) :-
  node(Queue, "cloud:aws:sqs", QueueName, _),
  QueueName = "orders-queue",
  edge(Func, Queue, "SUBSCRIBES_TO"),
  node(Func, "FUNCTION", _, _).

// Include the alert that should have fired
queue_alerts(Alert, QueueName) :-
  node(Queue, "cloud:aws:sqs", QueueName, _),
  edge(Queue, Alert, "MONITORED_BY").
```

### 5.3 Configuration Audit

**Question:** "What services use the database credentials secret?"

```datalog
secret_users(Service, Secret) :-
  node(Secret, "infra:k8s:secret", "db-credentials", _),
  edge(Service, Secret, "USES_SECRET"),
  node(Service, "SERVICE", _, _).
```

### 5.4 Cross-Environment Diff

**Question:** "What's different between staging and prod for payment-service?"

```datalog
// Staging deployments
staging_config(Service, Node, Type) :-
  node(Service, "SERVICE", "payment-service", _),
  (
    edge(Service, Node, "DEPLOYED_TO") ;
    edge(Service, Node, "CONFIGURED_BY") ;
    edge(Service, Node, "USES_SECRET")
  ),
  node(Node, Type, _, Meta),
  json_get(Meta, "env", "staging").

// Prod deployments
prod_config(Service, Node, Type) :-
  node(Service, "SERVICE", "payment-service", _),
  (
    edge(Service, Node, "DEPLOYED_TO") ;
    edge(Service, Node, "CONFIGURED_BY") ;
    edge(Service, Node, "USES_SECRET")
  ),
  node(Node, Type, _, Meta),
  json_get(Meta, "env", "prod").
```

---

## 6. Open Questions

### 6.1 Edge Metadata Consistency

**Question:** Should all cross-layer edges include `linkedBy` metadata?

**Current thinking:** Yes, for debugging. When a link seems wrong, users can query:
```datalog
// Find all heuristic-based links
heuristic_links(Src, Dst, Type) :-
  edge(Src, Dst, Type),
  edge_metadata(Src, Dst, Meta),
  json_get(Meta, "linkedBy", "convention").
```

**Recommendation:** Include `linkedBy` in all cross-layer edges.

### 6.2 Bidirectional Edges

**Question:** Should we create inverse edges (like Backstage's pairs)?

**Options:**
A) Single direction only (current approach)
B) Explicit inverse edges (`DEPLOYED_TO` / `DEPLOYMENT_OF`)
C) Virtual inverses (computed at query time)

**Recommendation:** Option A for now. Datalog can traverse edges in reverse direction. Adding explicit inverses doubles edge count without clear benefit.

### 6.3 Cloud Resource Identification

**Question:** How do we identify cloud resources that aren't in IaC?

For example: Lambda functions created manually, S3 buckets created via console.

**Options:**
A) Only track resources defined in analyzed IaC files
B) Allow explicit declaration in grafema.config.yaml
C) Future: API integration to discover cloud resources

**Recommendation:** Option A for MVP, with Option B as escape hatch.

```yaml
# grafema.config.yaml
cloud:
  explicit:
    - type: 'cloud:aws:s3'
      name: 'legacy-uploads'
      arn: 'arn:aws:s3:::legacy-uploads'
      linkedTo: 'SERVICE#file-service'
```

### 6.4 Observability Resource Discovery

**Question:** How do analyzers discover Prometheus rules, Grafana dashboards, etc.?

These are often in:
- Prometheus rules: YAML files in repo
- Grafana dashboards: JSON files or provisioned via config
- Datadog monitors: Terraform or manual

**Recommendation:** Same plugin pattern as infrastructure. Create `ObsAnalyzer` base class:
- `PrometheusRulesAnalyzer` - parses alert YAML
- `GrafanaDashboardAnalyzer` - parses dashboard JSON
- Terraform-defined monitors handled by `TerraformAnalyzer`

---

## 7. Implementation Notes for Joel

### 7.1 Edge Type Registration

Add to `packages/types/src/edges.ts`:
- New edge types from Section 4.2
- Metadata interfaces for each edge type

### 7.2 Edge Validation

Consider adding optional validation:
```typescript
interface EdgeTypeDefinition {
  name: string;
  allowedSources: string[];  // Node type patterns
  allowedTargets: string[];
  metadata?: z.ZodSchema;    // Zod schema for metadata validation
}
```

### 7.3 Query Helpers

Add helper functions for common cross-layer queries:
```typescript
// Find all paths from code to deployment
traceDeployment(serviceId: string): Promise<DeploymentPath[]>;

// Find all monitoring for a component
findMonitoring(nodeId: string): Promise<ObservabilityNode[]>;

// Cross-environment comparison
compareEnvironments(nodeId: string, envA: string, envB: string): Promise<EnvironmentDiff>;
```

---

## Sources

- [Backstage Well-known Relations](https://backstage.io/docs/features/software-catalog/well-known-relations/)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/concepts/semantic-conventions/)
- [OpenTelemetry Trace Conventions](https://opentelemetry.io/docs/specs/semconv/general/trace/)
- [AWS X-Ray Concepts](https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html)
- [AWS X-Ray Service Map](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-servicemap.html)
- [Istio Traffic Management](https://istio.io/latest/docs/concepts/traffic-management/)
- [Envoy Service Mesh Concepts](https://istio-insider.mygraphql.com/en/latest/ch1-istio-arch/service-mesh-base-concept.html)
- [Prometheus Alerting Rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
- [CI/CD Artifact Management Guide](https://www.withcoherence.com/articles/artifact-management-in-cicd-pipelines-guide)
- [Production Debugging Guide - Rookout](https://www.rookout.com/blog/production-debugging/)
