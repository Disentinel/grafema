# Universal System Graph (USG) Architecture

**Status:** Approved
**Date:** 2026-02-06
**Source:** REG-38 analysis (`_tasks/REG-38/`)

## Overview

USG extends Grafema from code-only analysis to multi-layer system graph covering:
- **Code Layer** — existing (SERVICE, FUNCTION, http:route, etc.)
- **Infrastructure Layer** — K8s, Docker Compose, Helm, etc.
- **Cloud Layer** — AWS, GCP, Azure resources
- **Observability Layer** — alerts, SLOs, dashboards

## Core Principle: Plugin-First, No Heuristics

**Grafema does NOT guess how code maps to infrastructure.**

Developers write custom analyzers for their projects. Grafema provides:
1. Abstract node types (`infra:k8s:*`, `cloud:aws:*`, `obs:*`)
2. `InfraAnalyzer` base class with clear contract
3. Reference implementations for common tools
4. Edge types for cross-layer linking

## InfraAnalyzer Interface

```typescript
abstract class InfraAnalyzer extends Plugin {
  phase = 'ANALYSIS';

  // Declare what this analyzer creates
  abstract declareNodeTypes(): string[];
  abstract declareEdgeTypes(): string[];

  // Find infrastructure files
  abstract discoverFiles(context: PluginContext): Promise<string[]>;

  // Parse file into resources
  abstract parseFile(filePath: string, content: string): InfraResource[];

  // THE KEY METHOD: Developer implements linking logic
  abstract linkToCode(
    resource: InfraResource,
    graph: Graph
  ): Promise<CrossLayerLink[]>;
}
```

## Node Type Conventions

**Format:** `layer:tool:resource`

| Layer | Prefix | Examples |
|-------|--------|----------|
| Infrastructure | `infra:` | `infra:k8s:deployment`, `infra:docker:service`, `infra:terraform:resource` |
| Cloud | `cloud:` | `cloud:aws:lambda`, `cloud:aws:sqs`, `cloud:gcp:function` |
| Observability | `obs:` | `obs:prometheus:rule`, `obs:grafana:dashboard`, `obs:slo` |

## Cross-Layer Edge Types

### Code <-> Infrastructure
| Edge | Source | Target | Question Answered |
|------|--------|--------|-------------------|
| `DEPLOYED_TO` | SERVICE, FUNCTION | infra:k8s:deployment | "Where is this deployed?" |
| `CONFIGURED_BY` | SERVICE | infra:k8s:configmap | "What config does this use?" |
| `USES_SECRET` | SERVICE | infra:k8s:secret | "What secrets does this need?" |
| `EXPOSED_VIA` | http:route | infra:k8s:ingress | "How is this exposed?" |
| `SCHEDULED_BY` | FUNCTION | infra:k8s:cronjob | "When does this run?" |

### Infrastructure <-> Cloud
| Edge | Source | Target | Question Answered |
|------|--------|--------|-------------------|
| `PROVISIONS` | infra:terraform:resource | cloud:aws:* | "What cloud resource does this IaC create?" |
| `TARGETS` | infra:k8s:deployment | cloud:aws:eks:cluster | "What cluster does this run on?" |

### Code <-> Cloud
| Edge | Source | Target | Question Answered |
|------|--------|--------|-------------------|
| `PUBLISHES_TO` | FUNCTION | cloud:aws:sqs | "Where does this send messages?" |
| `SUBSCRIBES_TO` | FUNCTION | cloud:aws:sqs | "What queue does this consume?" |
| `STORES_IN` | FUNCTION | cloud:aws:s3 | "Where does this persist data?" |
| `READS_FROM` | FUNCTION | cloud:aws:s3 | "Where does this read data from?" |
| `INVOKES_FUNCTION` | FUNCTION | cloud:aws:lambda | "What serverless functions does this call?" |

### Any <-> Observability
| Edge | Source | Target | Question Answered |
|------|--------|--------|-------------------|
| `MONITORED_BY` | SERVICE, infra:* | obs:prometheus:rule | "What alerts watch this?" |
| `MEASURED_BY` | http:route | obs:slo | "What SLO covers this?" |
| `VISUALIZED_IN` | SERVICE | obs:grafana:dashboard | "Where can I see metrics?" |
| `LOGS_TO` | SERVICE | cloud:aws:cloudwatch:loggroup | "Where are logs?" |

## Environment Metadata

```typescript
interface EnvironmentMetadata {
  env?: string | string[];  // undefined = all environments
}
```

- **Code nodes** — rarely have `env` (same code deployed everywhere)
- **Infra/Cloud/Obs nodes** — have `env` metadata
- **Query filtering** — no filter = all paths, with filter = filtered

### Example Queries

```datalog
// Find prod deployments only
prod_deployments(D) :-
  node(D, Type, _, Meta),
  string_concat("infra:k8s:", _, Type),
  json_get(Meta, "env", "prod").

// Services deployed to staging but not prod
staging_only(S) :-
  node(S, "SERVICE", _, _),
  edge(S, StagingDep, "DEPLOYED_TO"),
  node(StagingDep, _, _, StagingMeta),
  json_get(StagingMeta, "env", "staging"),
  not(edge(S, ProdDep, "DEPLOYED_TO"),
      node(ProdDep, _, _, ProdMeta),
      json_get(ProdMeta, "env", "prod")).
```

## Reference Implementations

| Analyzer | Parses | Creates | Effort |
|----------|--------|---------|--------|
| `K8sYamlAnalyzer` | K8s YAML manifests | `infra:k8s:*` | 3-5 days |
| `DockerComposeAnalyzer` | docker-compose.yaml | `infra:docker:*` | 2-3 days |
| `TerraformAnalyzer` | .tf HCL files | `infra:terraform:*`, `cloud:*` | 4-6 days |
| `NginxConfigAnalyzer` | nginx.conf | `infra:nginx:*` | 3-4 days |

## Configuration

```yaml
# grafema.config.yaml
infrastructure:
  enabled: true

  kubernetes:
    enabled: true
    paths:
      - 'k8s/**/*.yaml'
    # Explicit mappings (override auto-detection)
    mappings:
      - deployment: 'user-api'
        service: 'apps/user-api'

  terraform:
    enabled: false
    paths:
      - 'terraform/**/*.tf'

  # Custom analyzer for project-specific infra
  custom:
    analyzerPath: '.grafema/analyzers/my-infra-analyzer.ts'
```

## Implementation Roadmap

1. **Phase 1** (2-3 weeks): Infrastructure Framework
   - `InfraAnalyzer` base class
   - Configuration schema
   - Edge types registration

2. **Phase 2** (1 week): K8sYamlAnalyzer reference implementation

3. **Phase 3** (2-3 weeks): Additional reference implementations

4. **Phase 4** (1 week): AI Agent documentation for custom analyzers

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Identity Resolution | Plugin-based, no heuristics | Developers know their systems better than any algorithm |
| Node type registration | Strings, no formal registry | Flexibility over strictness |
| Edge direction | Dependent -> Provider | Consistent direction for queries |
| Environment | Optional metadata + query filter | Same code deployed to multiple envs |
| Failure handling | ISSUE nodes | Never silent skip, always visible |

## What USG Does NOT Do

- **No heuristics** — we don't guess code-to-infra mappings
- **No auto-discovery magic** — explicit configuration
- **No runtime integration** — static analysis only (files in repo)
- **No exhaustive node catalog** — convention + examples, not complete list

## Related Documents

- `_tasks/REG-38/006-don-revised-analysis.md` — Full plugin-first architecture
- `_tasks/REG-38/007-steve-final-review.md` — Architecture review
- `_tasks/REG-38/008-cross-layer-edges.md` — Edge types design
