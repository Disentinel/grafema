# UX Vision — REG-256 (from Вадим)

## Core Insight

Routing in real projects can come from multiple sources simultaneously:
- config.yaml (manual rules)
- nginx.conf
- k8s service definitions
- Application-level routing (Express mount points — REG-253)
- Any custom source

A single plugin can't handle all of these. Need modular rule extraction + abstract matching.

## Architecture (3 layers)

### Layer 1: Rule Extraction (modular, extensible)
Multiple **RoutingMapBuilder** plugins, each knows its source:
- `ConfigRoutingMapBuilder` — reads `routing` from config.yaml (this task)
- `NginxRoutingMapBuilder` — parses nginx.conf (future)
- `K8sRoutingMapBuilder` — parses k8s service definitions (future)

All write rules into a shared **RoutingMap** Resource.

### Layer 2: RoutingMap (shared Resource)
Abstract routing map. Source-agnostic. Knows:
"request from service A with path P → routes to service B with path P'"

Built incrementally by multiple builder plugins.

**Storage: New "Resource" concept** — formal shared data mechanism between plugins.
Not a graph node. Not a PluginContext field. A first-class extensible concept.

### Layer 3: Matching (abstract)
`findMatch(context)` — takes request context (service, path, method, etc.), uses RoutingMap, finds matching route. Doesn't know where rules came from.

## Key Design Decisions (from user)

1. **New plugin replaces HTTPConnectionEnricher entirely**
2. **customerFacing: true** — plugin marks route nodes. If marked and unconnected → no alarm. If NOT marked and unconnected → ISSUE node.
3. **customerFacing** is set "на усмотрение разработчика" (developer's explicit choice)
4. **Resource** is a new formal concept in the plugin system
5. **Scope:** Full architecture (Resource + RoutingMap + Builder interface + findMatch) but only ConfigRoutingMapBuilder as first implementation

## Config UX (target)

```yaml
services:
  - name: backend
    path: apps/backend
    entryPoint: src/index.ts
    customerFacing: true          # routes MUST have frontend consumers
  - name: auth-service
    path: apps/auth
    entryPoint: src/index.ts
  - name: frontend
    path: apps/frontend
    entryPoint: src/main.tsx

routing:
  - from: frontend
    to: backend
    stripPrefix: /api             # /api/users → /users
  - from: frontend
    to: auth-service
    stripPrefix: /auth            # /auth/login → /login
```
