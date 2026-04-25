# REG-38: Universal System Graph Architecture Analysis

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-06
**Status:** Initial Analysis

## Executive Summary

The Universal System Graph (USG) proposal aims to expand Grafema from a code-centric analysis tool to a multi-layer system graph spanning code, infrastructure, cloud, and observability. This analysis evaluates architectural fit with Grafema's vision and provides recommendations.

**Key Finding:** USG represents a significant expansion that requires careful scoping to avoid mission drift. The core value proposition aligns with Grafema's vision ("AI should query the graph, not read code"), but implementation must be incremental and maintain backward compatibility.

---

## 1. Current Architecture Summary

### 1.1 Graph Model

Grafema uses a **property graph** model with:

- **Nodes** (`BaseNodeRecord`): id, type, name, file, metadata
- **Edges** (`EdgeRecord`): src, dst, type, metadata
- **Namespaced types**: e.g., `http:route`, `db:query`, `event:listener`

Current node type categories:
```
Code Layer (existing):
- Structural: FUNCTION, CLASS, METHOD, VARIABLE, PARAMETER
- Module: MODULE, IMPORT, EXPORT, EXTERNAL_MODULE
- Control flow: BRANCH, CASE, LOOP, TRY_BLOCK, CATCH_BLOCK
- Side effects: http:route, http:request, db:query, event:listener
- Meta: GUARANTEE, ISSUE
```

### 1.2 Plugin Architecture

Five-phase pipeline:
```
DISCOVERY -> INDEXING -> ANALYSIS -> ENRICHMENT -> VALIDATION
```

Plugin contract:
```typescript
interface IPlugin {
  metadata: PluginMetadata;  // name, phase, priority, creates, dependencies
  execute(context: PluginContext): Promise<PluginResult>;
}
```

Key insight: **Forward registration pattern** - analyzers mark data during AST traversal, enrichers resolve cross-file relationships. This is the correct pattern for USG.

### 1.3 Storage Backend

RFDB (Rust) provides:
- Fast property graph storage
- Datalog query engine for guarantees
- BFS/DFS traversal primitives
- Multi-database support (v2 protocol)

### 1.4 Existing Cross-Layer Patterns

Grafema already has proto-cross-layer linking:
- `HTTPConnectionEnricher`: links `http:request` (frontend) to `http:route` (backend)
- `HTTP_RECEIVES` edges: links response data flow across service boundaries

This demonstrates the **pattern we need to extend**: enrichers that resolve references across layers.

---

## 2. Prior Art Research

### 2.1 Joern Code Property Graph

**Source:** [Joern CPG Specification](https://cpg.joern.io/), [Joern Documentation](https://docs.joern.io/code-property-graph/)

Key concepts:
- **Layered schema**: File System Layer, Namespace Layer, AST Layer, CFG Layer, PDG Layer
- **Language-agnostic base**: Common node types (File, Method, Call, etc.)
- **Language frontends**: Separate parsers map to common schema
- **Merging representations**: AST + CFG + PDG in single graph

**Relevance to USG:**
- Grafema already follows similar layered approach
- Our namespaced types (`http:route`, `db:query`) are analogous to Joern's semantic layers
- Key difference: Joern focuses on security analysis, Grafema on system understanding

### 2.2 Backstage Entity Model

**Source:** [Backstage System Model](https://backstage.io/docs/features/software-catalog/system-model/), [Backstage Entity Model](https://backstage.io/docs/features/software-catalog/extending-the-model/)

Entity hierarchy:
```
Domain
  -> System
    -> Component (service, website, library)
    -> Resource (database, S3 bucket)
    -> API (REST, gRPC, event)
```

Key concepts:
- **Kubernetes-style manifests**: metadata, spec, relations
- **Entity references**: `component:default/my-service`
- **Relations**: ownedBy, dependsOn, consumesApi, providesApi

**Relevance to USG:**
- Backstage is **catalog-first** (YAML manifests define entities)
- Grafema is **analysis-first** (extract entities from code)
- USG should enable both modes: discovered entities + declared entities
- Backstage's `Domain -> System -> Component` hierarchy could map to SERVICE nodes

### 2.3 Terraform Graph Model

**Source:** [Terraform Dependency Graph](https://developer.hashicorp.com/terraform/internals/graph), [Terraform DAG Internals](https://stategraph.com/blog/terraform-dag-internals)

Key concepts:
- **DAG-based execution**: Resources depend on other resources
- **Node types**: ResourceNode, ProviderConfigNode, MetaNode
- **Implicit dependencies**: Interpolation parsing
- **Explicit dependencies**: `depends_on`

**Relevance to USG:**
- Terraform's resource graph is **declarative infrastructure** that USG could ingest
- Cross-layer linking: `aws_lambda_function.handler` -> code function
- Resource identifiers (ARNs, URIs) as linking keys

### 2.4 Universal Microservice Architecture (UMA)

**Source:** [UMA Article](https://medium.com/the-rise-of-device-independent-architecture/inside-a-universal-microservice-architecture-uma-bb04cf6343ac)

Key insight: Services as **self-describing nodes** with metadata for compatibility. This maps to Grafema's SERVICE nodes with enriched metadata.

### 2.5 Cloud-Native Observability

**Source:** [CNCF Observability Trends](https://www.cncf.io/blog/2025/03/05/observability-trends-in-2025-whats-driving-change/)

Key patterns:
- **OpenTelemetry**: Vendor-agnostic trace/metric/log collection
- **Service topology graphs**: Auto-discovered from traces
- **Context propagation**: Trace IDs linking requests across services

**Relevance to USG:**
- Observability layer could be populated from trace data
- Trace spans map to runtime call graph
- SLOs/alerts could be GUARANTEE-like nodes

---

## 3. Vision Alignment Analysis

### 3.1 Core Question: Does USG Expand or Distract?

Grafema's vision: **"AI should query the graph, not read code."**

USG extends this to: **"AI should query the graph, not read code/infra/config."**

This is a **natural extension** of the vision, PROVIDED:
1. Code layer remains primary (where Grafema excels)
2. Infrastructure layer adds value for code understanding
3. Query language remains unified

### 3.2 Target Environment Fit

Grafema targets: "Massive legacy codebases where migration to typed languages is economically unfeasible."

USG value proposition:
- Legacy systems often have **complex infrastructure** (not just code)
- Understanding `sendToQueue('orders')` requires knowing what consumes that queue
- Understanding `invoke('/api/process')` requires knowing what AWS Lambda runs that code

**Verdict:** Strong alignment. Legacy systems need multi-layer understanding.

### 3.3 Risk: Mission Drift

Danger: USG could become an "everything graph" that's good at nothing.

Mitigation:
1. **Code layer first**: USG Phase 1 focuses on code-to-infra linking
2. **Lazy evaluation**: Don't build all layers at once
3. **Plugin isolation**: Each layer is optional, loaded on demand
4. **Clear boundaries**: Code analysis remains Grafema's core

---

## 4. Architectural Approach

### 4.1 Core Graph Schema (Extended)

```typescript
// Layer prefixes for namespaced types
const LAYER_PREFIX = {
  code: '',           // No prefix for backward compat (FUNCTION, http:route)
  infra: 'infra:',    // infra:k8s:deployment, infra:terraform:resource
  cloud: 'cloud:',    // cloud:aws:lambda, cloud:aws:sqs
  observability: 'obs:', // obs:alert, obs:slo, obs:trace
} as const;

// Example node types per layer
const USG_NODE_TYPES = {
  // Code layer (existing + extensions)
  'http:route': 'HTTP route handler',
  'queue:publish': 'Message queue publish',
  'queue:subscribe': 'Message queue consumer',

  // Infrastructure layer (new)
  'infra:k8s:deployment': 'Kubernetes Deployment',
  'infra:k8s:service': 'Kubernetes Service',
  'infra:terraform:resource': 'Terraform resource',
  'infra:helm:chart': 'Helm chart',

  // Cloud layer (new)
  'cloud:aws:lambda': 'AWS Lambda function',
  'cloud:aws:sqs': 'AWS SQS queue',
  'cloud:aws:iam:policy': 'IAM policy',

  // Observability layer (new)
  'obs:alert': 'Alert rule',
  'obs:slo': 'SLO definition',
  'obs:trace': 'Trace span',
};
```

### 4.2 Cross-Layer Edge Resolution

Key insight from HTTPConnectionEnricher: **Cross-layer linking happens in ENRICHMENT phase**.

Pattern: **Semantic identifiers** as linking keys:

```typescript
// Code declares intent
const codeNode = {
  type: 'queue:publish',
  queueName: 'orders',
  // This is a "forward registration" - code marks what it publishes to
};

// Infrastructure declares resource
const infraNode = {
  type: 'infra:terraform:resource',
  resourceType: 'aws_sqs_queue',
  resourceName: 'orders',
  // ARN, URI, or other identifier
};

// Enricher creates cross-layer edge
// LINKED_TO edge connects code -> infra
```

Cross-layer edge types:
```typescript
const CROSS_LAYER_EDGES = {
  DEPLOYED_TO: 'Code -> Infrastructure (function deployed as Lambda)',
  LINKED_TO: 'Code -> Infrastructure (queue publish -> SQS)',
  PROVISIONED_BY: 'Infrastructure -> Cloud (k8s -> AWS)',
  MONITORED_BY: 'Code/Infra -> Observability (function -> alert)',
};
```

### 4.3 Plugin Interface Extension

No breaking changes needed. USG plugins follow existing pattern:

```typescript
// Example: KubernetesAnalyzer plugin
class KubernetesAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'KubernetesAnalyzer',
      phase: 'ANALYSIS',  // Same phase as code analyzers
      creates: {
        nodes: ['infra:k8s:deployment', 'infra:k8s:service'],
        edges: ['CONTAINS', 'EXPOSES'],
      },
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // Parse kubernetes YAML manifests
    // Create infra:k8s:* nodes
    // Forward-register linking info in metadata
  }
}

// Example: CodeToK8sEnricher plugin
class CodeToK8sEnricher extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'CodeToK8sEnricher',
      phase: 'ENRICHMENT',
      dependencies: ['JSModuleIndexer', 'KubernetesAnalyzer'],
      creates: { edges: ['DEPLOYED_TO'] },
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // Find SERVICE nodes with entrypoint
    // Find infra:k8s:deployment nodes with matching image
    // Create DEPLOYED_TO edges
  }
}
```

### 4.4 Query Language Considerations

Current Grafema queries work via:
1. Node type filtering (`queryNodes({ type: 'http:route' })`)
2. Attribute filtering (`findByAttr({ file: '...' })`)
3. Graph traversal (BFS, DFS, edges)
4. Datalog queries for guarantees

USG requirements:
- Query across layers: "Find all Lambda functions that handle requests to /api/users"
- Cross-layer traversal: "From this code function, what infra deploys it?"

**Recommendation:** No new query language needed. Existing Datalog + graph traversal is sufficient:

```datalog
// Find code functions deployed as Lambda
deployed_lambda(FuncId, LambdaId) :-
  node(FuncId, "FUNCTION", _, _),
  edge(FuncId, LambdaId, "DEPLOYED_TO"),
  node(LambdaId, "cloud:aws:lambda", _, _).
```

### 4.5 Schema Inference Architecture

USG proposes automatic schema extraction. This maps to existing patterns:

1. **Code schemas**: Already extracted (function signatures, types)
2. **API schemas**: OpenAPI/Swagger parsing (new analyzer)
3. **Message schemas**: JSON Schema from queue payloads (new analyzer)
4. **Database schemas**: DDL parsing or runtime introspection (new analyzer)

Schema nodes could be `schema:*` namespaced types linked to their sources.

---

## 5. Key Architectural Decisions

### Decision 1: Layered vs Flat Namespace

**Options:**
A) Flat namespace with prefixes: `infra:k8s:deployment`
B) Separate graphs per layer with cross-references
C) Hierarchical namespace with layer metadata

**Recommendation:** Option A (flat with prefixes)

Rationale:
- Maintains single unified graph (simpler queries)
- Backward compatible (code layer has no prefix)
- Layer is encoded in type, queryable
- RFDB already supports arbitrary node types

### Decision 2: Linking Strategy

**Options:**
A) Explicit linking via configuration (user declares code X -> infra Y)
B) Heuristic linking (match by name, path, annotation)
C) Annotation-based linking (code annotates what infra it uses)

**Recommendation:** Option B with A fallback

Rationale:
- Heuristics work for common patterns (image name -> deployment)
- Configuration handles edge cases
- Annotations are nice-to-have but not required
- Matches existing pattern (HTTPConnectionEnricher uses path matching)

### Decision 3: Discovery Scope

**Options:**
A) Discover everything in project (code + all infra files)
B) Explicit configuration of infra sources
C) Auto-detect based on file patterns

**Recommendation:** Option C with B override

Rationale:
- `*.yaml` in `k8s/`, `terraform/` directories auto-discovered
- `grafema.yaml` config can override/extend
- Matches current service discovery pattern

### Decision 4: Plugin Loading

**Options:**
A) All USG plugins bundled in core
B) Separate `@grafema/usg-infra` package
C) Plugin discovery via npm/registry

**Recommendation:** Option B initially, C long-term

Rationale:
- Keeps core small for code-only users
- Optional install: `npm install @grafema/usg-infra`
- Future plugin registry for community contributions

---

## 6. Risks and Open Questions

### 6.1 Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Mission drift | High | Phase 1 focuses only on code-k8s linking |
| Complexity explosion | High | Each layer is optional, loaded on demand |
| Query performance | Medium | Indexed by layer prefix, lazy loading |
| Stale infra data | Medium | Incremental analysis, file watching |
| Over-engineering | Medium | Start with minimal schema, extend as needed |

### 6.2 Open Questions

1. **Identity resolution**: How to reliably link code function to k8s deployment?
   - Container image name?
   - Environment variables referencing service?
   - Directory structure conventions?

2. **Multi-environment support**: Does USG model dev/staging/prod differently?
   - Option: Environment as node metadata
   - Option: Separate SERVICE nodes per environment

3. **Real-time vs static**: Should USG integrate with running systems?
   - Initial: Static analysis only (files in repo)
   - Future: Optional integration with k8s API, AWS API

4. **Guarantee scope**: How do guarantees work across layers?
   - "Every http:route must have a k8s:ingress" (cross-layer guarantee)
   - Datalog can express this, but UX needs design

---

## 7. Recommended Next Steps

### Phase 1: Proof of Concept (Recommended Start)

Scope: TypeScript + Kubernetes linking

1. **KubernetesAnalyzer plugin**
   - Parse k8s YAML in `k8s/`, `kubernetes/`, `.k8s/` directories
   - Create `infra:k8s:deployment`, `infra:k8s:service` nodes
   - Extract container image, ports, env vars

2. **CodeToK8sEnricher plugin**
   - Link SERVICE nodes to `infra:k8s:deployment` by:
     - Container image name matching service name
     - Directory structure (service at `apps/foo`, k8s at `k8s/foo`)
   - Create DEPLOYED_TO edges

3. **Demo query**
   - "Show me which k8s deployment runs this Express handler"
   - "Find all endpoints exposed by infra but not implemented in code"

### Phase 2: Terraform Integration

Add `TerraformAnalyzer` for AWS resources, link to code via:
- Queue names (SQS)
- Lambda function names
- API Gateway routes

### Phase 3: Observability Layer

Integrate with:
- Prometheus alert rules
- SLO definitions
- (Optional) Live trace data from OpenTelemetry

---

## 8. Conclusion

USG is a **valid extension** of Grafema's vision, not a distraction. The key insight is that understanding code in isolation is insufficient for legacy systems - you need to see how code connects to infrastructure.

**However**, the implementation must be:
1. **Incremental** - Start with code-to-k8s, prove value, then expand
2. **Optional** - Code-only analysis remains the default
3. **Backward compatible** - Existing queries and guarantees continue to work

The proposed architecture leverages existing patterns (plugin phases, enrichment, Datalog) and requires no fundamental changes to Grafema's core.

**Recommended Action:** Approve Phase 1 PoC scope (TypeScript + Kubernetes) and create detailed technical spec.

---

## Sources

- [Joern CPG Specification](https://cpg.joern.io/)
- [Joern Code Property Graph Documentation](https://docs.joern.io/code-property-graph/)
- [Backstage System Model](https://backstage.io/docs/features/software-catalog/system-model/)
- [Backstage Entity Model Extension](https://backstage.io/docs/features/software-catalog/extending-the-model/)
- [Terraform Dependency Graph](https://developer.hashicorp.com/terraform/internals/graph)
- [Terraform DAG Internals](https://stategraph.com/blog/terraform-dag-internals)
- [CNCF Observability Trends 2025](https://www.cncf.io/blog/2025/03/05/observability-trends-in-2025-whats-driving-change/)
- [Universal Microservice Architecture](https://medium.com/the-rise-of-device-independent-architecture/inside-a-universal-microservice-architecture-uma-bb04cf6343ac)
