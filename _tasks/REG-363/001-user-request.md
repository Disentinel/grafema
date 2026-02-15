# REG-363: USG Phase 1 — Infrastructure Plugin Framework

## Goal

Create the base framework for infrastructure analysis plugins.

## Deliverables

### 1. InfraAnalyzer Base Class

```typescript
abstract class InfraAnalyzer extends Plugin {
  abstract declareNodeTypes(): string[];
  abstract declareEdgeTypes(): string[];
  abstract discoverFiles(context: PluginContext): Promise<string[]>;
  abstract parseFile(filePath: string, content: string): InfraResource[];
  abstract linkToCode(resource: InfraResource, graph: Graph): Promise<CrossLayerLink[]>;
}
```

### 2. Cross-Layer Edge Types

Add to `packages/types/src/edges.ts`:

- DEPLOYED_TO, CONFIGURED_BY, USES_SECRET, EXPOSED_VIA, SCHEDULED_BY
- PROVISIONS, TARGETS
- PUBLISHES_TO, SUBSCRIBES_TO, STORES_IN, READS_FROM, INVOKES_FUNCTION
- MONITORED_BY, MEASURED_BY, VISUALIZED_IN, LOGS_TO

### 3. Configuration Schema

```yaml
infrastructure:
  enabled: true
  kubernetes:
    enabled: true
    paths: ['k8s/**/*.yaml']
    mappings: [...]
```

### 4. Environment Metadata

- `env?: string | string[]` on infra/cloud/obs nodes
- Query filtering support

## Acceptance Criteria

- [ ] InfraAnalyzer base class with AI agent documentation
- [ ] All edge types registered
- [ ] Config schema validates
- [ ] Unit tests for base class
- [ ] Documentation in `_ai/usg-architecture.md` up to date
