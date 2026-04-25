# Infrastructure Layer Model

**Status:** Research / Design
**Date:** 2026-03-13
**Origin:** REG-667 — BEAM infrastructure lives in code, not configs. First implementation of Grafema's runtime/process modeling.
**Linear:** REG-667

## Core Insight

Every system has two layers:

```
CODE LAYER:           MODULE → FUNCTION → VARIABLE → CALL → ...
                      Source: .js, .ts, .hs, .ex, .erl, .py

INFRASTRUCTURE LAYER: PROCESS → MESSAGE → SERVICE → SUPERVISOR → ...
                      Source: depends on ecosystem ↓
```

| Ecosystem | Where infra lives | Format |
|-----------|-------------------|--------|
| **BEAM** | In code | `.ex`, `.erl` |
| **K8s** | In manifests | `.yaml` |
| **Docker** | In Dockerfiles + compose | `Dockerfile`, `.yaml` |
| **Terraform** | In configs | `.tf` (HCL) |
| **Systemd** | In unit files | `.service`, `.timer` |
| **Serverless** | In configs | `serverless.yml`, SAM |

**Key: source differs, graph is one.** A PROCESS node is the same whether it came from `Supervisor.start_link` or `kind: Deployment`.

## Semantic Roles: Code ↔ Infrastructure Parallel

Infrastructure roles are NOT new — they parallel code roles in a different domain:

| Code role | Infra analogue | What it models |
|-----------|----------------|----------------|
| Callable | **Runnable** | Something that can be started (process, container, service) |
| Invocation | **Spawn** | Act of starting (start_link, kubectl apply, docker run) |
| Declaration | **Definition** | Description of how to start (module def, Deployment spec) |
| Import | **Dependency** | Dependency on another service (depends_on, mix dep) |
| Assignment | **Configuration** | Binding a value (env vars, config, state init) |
| Access | **Communication** | Reaching another process/service (message, HTTP, gRPC) |
| Control | **Orchestration** | Lifecycle management (supervisor, restart policy, health check) |

## Projections: Code ↔ Infrastructure Parallel

Same 7 projections, different domain:

| Code projection | Infra projection | What it shows |
|----------------|-------------------|---------------|
| Call Graph | **Communication Graph** | Who talks to whom (messages, HTTP, queues) |
| DFG | **Data Pipeline** | How data flows between services |
| CFG | **Lifecycle Graph** | Start/stop ordering |
| Scope | **Isolation Graph** | Visibility boundaries (namespace, network, node) |
| Module Graph | **Deployment Graph** | What deploys where |
| Structure | **Topology Graph** | Physical/logical structure (supervision tree, pod topology) |
| Type | **Protocol Graph** | Contracts between services (protobuf, OpenAPI, behaviour) |

Projections are universal because they describe how HUMANS think about systems (L5, Cognitive Dimensions), not domain specifics.

## The Bridge: Code ↔ Infrastructure Edges

The highest value is in edges BETWEEN layers:

```
CODE LAYER                          INFRASTRUCTURE LAYER
──────────                          ────────────────────
MODULE MyApp.Worker
  └─ FUNCTION handle_call  ──HANDLES_IN──→  PROCESS MyApp.Worker
  └─ FUNCTION init         ──INITIALIZES──→ PROCESS MyApp.Worker

MODULE MyApp.Supervisor
  └─ CALL start_link       ──SPAWNS──→      PROCESS MyApp.Worker
                                            PROCESS MyApp.Cache

MODULE MyApp.Router
  └─ FUNCTION call          ──SERVES──→     SERVICE web:4000
```

For BEAM: bridges are IN code — extracted from AST.
For K8s: bridges are BETWEEN files — `image: myapp` links Deployment to Dockerfile/entrypoint.

## BEAM Implementation (First)

### Why BEAM First

1. **Bridge in code** — no YAML/HCL parser needed, parse Elixir → get both layers
2. **Explicit constructs** — `Supervisor.init(children, strategy:)` = supervision tree literally in code
3. **Closed system** — BEAM app is self-contained, no cross-config assembly needed
4. **Validates model** — if infra projections work for BEAM → they'll work for K8s (less expressive)

### Node Types

```
PROCESS              — BEAM process (GenServer, Agent, Task, etc.)
  metadata: {registered_name, module, strategy, restart}

SUPERVISION_TREE     — group of processes under one supervisor
  metadata: {strategy: one_for_one|one_for_all|rest_for_one}

MESSAGE_TYPE         — message pattern in handle_call/cast/info
  metadata: {pattern, direction: call|cast|info}
```

### Edge Types (Bridge)

```
SPAWNS               — Supervisor/start_link → PROCESS
HANDLES_IN           — FUNCTION handle_* → PROCESS
SENDS_TO             — CALL GenServer.call/cast → PROCESS
RECEIVES             — MESSAGE_TYPE → FUNCTION handle_*
SUPERVISES           — PROCESS(supervisor) → PROCESS(child)
```

### PID Resolution Strategy

Full resolution of `GenServer.call(pid, msg)` is statically undecidable. OTP conventions cover 80%+:

```elixir
# Convention 1: registered name (statically resolvable)
GenServer.start_link(__MODULE__, [], name: MyApp.Cache)
GenServer.call(MyApp.Cache, :get)  # → target = MyApp.Cache

# Convention 2: module-as-API (statically resolvable)
defmodule MyApp.Cache do
  def get(), do: GenServer.call(__MODULE__, :get)  # self-call
end

# Convention 3: dynamic PID (NOT resolvable)
{:ok, pid} = GenServer.start_link(SomeModule, [])
GenServer.call(pid, :get)  # → UNRESOLVED, metadata: resolution="dynamic_pid"
```

## Future: K8s, Docker, Terraform

Same node types, different sources:

| BEAM | K8s | Docker | Terraform |
|------|-----|--------|-----------|
| PROCESS (GenServer) | Pod | Container | Instance |
| SUPERVISION_TREE | Deployment/StatefulSet | docker-compose service group | Module |
| MESSAGE_TYPE | Service port/endpoint | exposed port | Output |
| SPAWNS | Deployment → Pod | compose up → container | apply → resource |
| SUPERVISES | ReplicaSet → Pod | depends_on | depends_on |
| SENDS_TO | Service → Pod | network link | reference |

Implementation order: BEAM (code) → K8s (YAML) → Docker (Dockerfile + YAML) → Terraform (HCL).

## Related

- [Theoretical Foundations](./theoretical-foundations.md) — L2/L3 theory
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — matrix approach
- REG-667: BEAM implementation (first infrastructure layer)
