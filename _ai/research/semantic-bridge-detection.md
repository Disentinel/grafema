# Semantic Bridge Detection via Effects-Based IPC Analysis

**Status:** Research / Formal Model
**Date:** 2026-03-30
**Origin:** Grafema's 14 internal IPC boundaries need formalization to enable automated cross-process dataflow detection

## 1. Introduction

Static analysis traditionally operates within a single process boundary. Functions call functions, data flows through arguments and return values, control follows branches and loops. But real-world systems are not single processes. A CLI spawns a daemon. A server listens on a socket. A browser fetches from an HTTP endpoint. Each of these boundaries is invisible to conventional static analysis because the communication happens through the operating system, not through language-level function calls.

Grafema's effects taxonomy already classifies functions by their side effects: IO, MUTATION, THROW, ASYNC, PURE. The key insight is that **IO effects encode directionality and transport**. A function that writes to a Unix socket and a function that reads from the same Unix socket form a communication pair -- a Bridge -- even though they share no call graph edge, may be written in different languages, and run in different processes.

This document formalizes Bridge detection as a static analysis technique. The core claim: by decomposing the IO effect into directional subtypes and extracting channel identifiers from arguments, we can automatically discover inter-process communication boundaries from the graph alone, without runtime tracing.


## 2. Formal Model

### Definition 2.1: Bridge

A **Bridge** is a 5-tuple:

```
B = (Sender, Receiver, Channel, Transport, Protocol)
```

where:

- **Sender** -- a function node in the graph with an effect of the form `IO:TRANSPORT:WRITE` or `IO:TRANSPORT:CONNECT`. The sender initiates or pushes data into the channel.
- **Receiver** -- a function node in the graph with an effect of the form `IO:TRANSPORT:READ` or `IO:TRANSPORT:LISTEN`. The receiver consumes data from the channel.
- **Channel** -- a value, extractable from source code or configuration, that identifies the shared resource. Socket paths, URLs, binary names, environment variable keys. The channel is what makes sender and receiver talk to *each other* rather than to arbitrary endpoints.
- **Transport** -- the communication mechanism: `unix_socket`, `tcp`, `http`, `subprocess_stdio`, `env_var`, `file`, `shared_memory`. Transport determines which complementary effect pairs to match.
- **Protocol** -- the serialization format used over the transport: `msgpack`, `json`, `ndjson`, `cli_args`, `protobuf`, `binary`. Protocol does not affect bridge detection but is essential for understanding what crosses the boundary.

### Definition 2.2: Bridge Graph

Given a program graph G = (N, E) with effect annotations, the **Bridge Graph** BG = (N, E_B) is a derived graph where:

```
E_B = { (s, r, ch) | s ∈ Senders(G), r ∈ Receivers(G),
                      complementary(effect(s), effect(r)),
                      channel(s) ≡ channel(r) }
```

Bridge edges are synthetic -- they do not exist in the original call graph. They represent dataflow that crosses process boundaries. Adding bridge edges to the program graph closes the inter-process dataflow gap and enables end-to-end tracing from user input to final output, even across language and process boundaries.

### Definition 2.3: Channel Equivalence

Two channel identifiers `ch_s` and `ch_r` are equivalent (`ch_s ≡ ch_r`) when they resolve to the same runtime resource. Equivalence classes:

- **Literal match**: `"/tmp/rfdb.sock"` = `"/tmp/rfdb.sock"`
- **Variable resolution**: `socketPath` in sender resolves to same value as `socketPath` in receiver via dataflow analysis
- **Pattern match**: sender URL `http://localhost:3333/api/*` matches receiver route `/api/:endpoint`
- **Config-mediated**: both reference the same config key (e.g., `config.socketPath`)

Channel equivalence is the primary source of both false positives and false negatives (Section 5).


## 3. Effect Subtype Hierarchy

The current Grafema effects taxonomy (v1) treats IO as a single flat category. Bridge detection requires decomposing IO into a two-level hierarchy: **transport** and **direction**.

```
IO
├── IO:SOCKET
│   ├── IO:SOCKET:CONNECT      # open a connection to a socket
│   ├── IO:SOCKET:LISTEN        # bind and listen on a socket
│   ├── IO:SOCKET:WRITE         # send data through a socket
│   └── IO:SOCKET:READ          # receive data from a socket
├── IO:HTTP
│   ├── IO:HTTP:REQUEST         # send an HTTP request (client)
│   └── IO:HTTP:LISTEN          # register an HTTP handler (server)
├── IO:PROCESS
│   ├── IO:PROCESS:SPAWN        # create a child process
│   ├── IO:PROCESS:STDIN_WRITE  # write to child's stdin
│   ├── IO:PROCESS:STDIN_READ   # read from own stdin (child side)
│   ├── IO:PROCESS:STDOUT_WRITE # write to own stdout (child side)
│   └── IO:PROCESS:STDOUT_READ  # read from child's stdout (parent side)
├── IO:FILE
│   ├── IO:FILE:READ            # read from filesystem
│   └── IO:FILE:WRITE           # write to filesystem
└── IO:ENV
    ├── IO:ENV:READ             # read environment variable
    └── IO:ENV:SET              # set environment variable
```

This hierarchy is backwards-compatible with the existing taxonomy. Every IO subtype is still an IO effect. Functions annotated as `[IO]` in existing effects-db entries retain their classification. The subtypes refine IO when more precise information is available.

### Hierarchy design principles

**Direction is mandatory.** Every IO subtype must encode whether data enters or leaves the process. Without direction, we cannot form complementary pairs.

**Transport is the grouping dimension.** Complementary pairs only match within the same transport. A socket write does not pair with an HTTP read, even if the channel identifiers happen to match.

**Symmetry is not assumed.** `IO:PROCESS:STDIN_WRITE` (parent writes to child's stdin) and `IO:PROCESS:STDIN_READ` (child reads its own stdin) describe the same pipe from opposite sides. The naming reflects which process performs the operation, not which end of the pipe.


## 4. Complementary Pair Matching

The core detection algorithm has three phases: effect classification, channel extraction, and pair matching.

### 4.1 Complementary Pair Table

Two effect subtypes are **complementary** when they represent opposite ends of the same communication channel:

| Write-side effect | Read-side effect | Transport | Bridge type |
|---|---|---|---|
| `IO:SOCKET:WRITE` | `IO:SOCKET:READ` | `unix_socket` / `tcp` | Socket bridge |
| `IO:SOCKET:CONNECT` | `IO:SOCKET:LISTEN` | `unix_socket` / `tcp` | Socket lifecycle bridge |
| `IO:HTTP:REQUEST` | `IO:HTTP:LISTEN` | `http` | HTTP bridge |
| `IO:PROCESS:SPAWN` | `IO:PROCESS:STDIN_READ` | `subprocess_stdio` | Subprocess bridge (down) |
| `IO:PROCESS:STDOUT_WRITE` | `IO:PROCESS:STDOUT_READ` | `subprocess_stdio` | Subprocess bridge (up) |
| `IO:FILE:WRITE` | `IO:FILE:READ` | `file` | File-mediated bridge |
| `IO:ENV:SET` | `IO:ENV:READ` | `env_var` | Environment bridge |

Note that `IO:PROCESS:SPAWN` pairs with `IO:PROCESS:STDIN_READ` because spawning a process *is* the act that creates the child's stdin. The parent spawns; the child reads. The binary name is the channel.

### 4.2 Channel Identity Extraction

Channel extraction is transport-specific. Each transport has characteristic argument positions or patterns:

**Unix socket / TCP:**
- Look for string arguments to `connect()`, `createConnection()`, `bind()`, `listen()`
- Extract: socket path (Unix) or host:port (TCP)
- Grafema representation: `trace_dataflow` from the socket path argument backward to find the defining value

**HTTP:**
- Client side: URL argument to `fetch()`, `http.request()`, `axios.get()`
- Server side: route pattern in `app.get('/api/...')`, `router.post('/...')`
- Match: URL path prefix against route pattern (glob or regex)

**Subprocess:**
- Binary name/path as first argument to `spawn()`, `exec()`, `child_process.fork()`
- Stdin/stdout are implicitly connected to the spawned binary's stdio
- Channel: the binary name itself

**Environment variable:**
- Key argument to `process.env[key]` (read) or assignment to `process.env[key]` (write)
- Channel: the environment variable name

**File:**
- Path argument to `fs.readFileSync()`, `fs.writeFileSync()`, etc.
- Channel: the file path

### 4.3 Matching Algorithm

```
function detectBridges(graph):
    writers = findNodes(graph, effect matches IO:*:WRITE | IO:*:CONNECT | IO:*:SPAWN | IO:*:SET)
    readers = findNodes(graph, effect matches IO:*:READ | IO:*:LISTEN)

    bridges = []
    for w in writers:
        for r in readers:
            if complementary(w.effect, r.effect):
                ch_w = extractChannel(w)
                ch_r = extractChannel(r)
                if ch_w ≡ ch_r:
                    confidence = computeConfidence(ch_w, ch_r)
                    bridges.append(Bridge(w, r, ch_w, transport(w), protocol(w, r), confidence))

    return bridges
```

In practice, the double loop is indexed: writers and readers are grouped by transport, then by channel, reducing the search space from O(W * R) to O(groups).


## 5. Soundness and Completeness

### 5.1 Soundness (No false negatives -- idealized)

A bridge detection is **sound** if every real IPC boundary in the running system is detected. Perfect soundness requires:

1. Every IO call in the codebase is annotated with the correct effect subtype
2. Every channel identifier is statically extractable
3. Channel equivalence is decidable

In practice, all three conditions are violated. Soundness is approximate.

### 5.2 Sources of False Negatives

**Dynamic channels.** When a socket path is computed at runtime (`socketPath = \`/tmp/\${name}.sock\``), static extraction may fail. Dataflow analysis can sometimes resolve the template; when it cannot, the channel is marked UNKNOWN and the bridge is missed.

**Indirect communication.** Process A writes to a database; Process B reads from it. If A and B do not share a direct transport channel, this is an indirect bridge. The current model does not detect bridges mediated by external state unless the database access is modeled as a file or socket transport.

**Third-party libraries.** If a library wraps socket communication behind an API (e.g., a custom RPC framework), the IO effect must propagate through the library's call graph. Missing effects-db annotations for the library cause false negatives.

**Cross-language boundaries.** A Rust server and a TypeScript client communicate over a socket. If only one side is analyzed, the bridge has a dangling end. Federation (Section 8) addresses this by joining graphs from different language analyzers.

### 5.3 Sources of False Positives

**Coincidental channel names.** Two unrelated services happen to use the same socket path string, but one is in dead code or a different deployment configuration. The model sees matching channels and reports a bridge that does not exist at runtime.

**Test fixtures.** Test code that creates mock servers with hardcoded paths may match production client code, producing phantom bridges.

**Conditional channels.** Code that uses different socket paths based on environment (dev vs. prod) may produce bridges that only exist in one environment.

### 5.4 Confidence Scoring

Each detected bridge carries a confidence score in [0.0, 1.0]:

| Factor | Score contribution |
|---|---|
| Literal string match for channel | +0.4 |
| Channel resolved via single-hop dataflow | +0.3 |
| Channel resolved via multi-hop dataflow | +0.2 |
| Channel contains template/interpolation | -0.2 |
| One side is in test code | -0.3 |
| Both sides in same package | +0.1 |
| Protocol evidence (matching serialization calls) | +0.1 |

A bridge with confidence below a configurable threshold (default: 0.3) is reported as CANDIDATE rather than CONFIRMED.


## 6. The 14 Grafema Boundaries

Grafema itself contains 14 IPC boundaries. Each maps onto the formal model. This serves both as validation (the model covers all real cases) and as a ground-truth dataset for testing the detector.

### Boundary Catalog

| # | Name | Sender | Receiver | Channel | Transport | Protocol |
|---|---|---|---|---|---|---|
| 1 | CLI -> Orchestrator | `spawn` in `analyzeAction.ts` | `main` in `main.rs` | `"grafema-orchestrator"` | subprocess | cli_args |
| 2 | Orchestrator -> RFDB | `RfdbClient.send` in `rfdb.rs` | `handle_request_with_cancel` in `rfdb_server.rs` | `".grafema/rfdb.sock"` | unix_socket | msgpack |
| 3 | Orchestrator -> Streaming Plugins | `run_streaming_plugin` in `plugin.rs` | `stdin_read` in `grafema-resolve` | binary_name | subprocess_stdio | ndjson |
| 4 | Orchestrator -> Batch Plugins | `run_batch_plugin` in `plugin.rs` | `RFDB_SOCKET` env read | env_var + socket | env_var | msgpack |
| 5 | Orchestrator -> Process Pool | `ProcessPool.request` in `process_pool.rs` | daemon stdin | `"grafema-resolve"` | subprocess_stdio | msgpack |
| 6 | CLI -> RFDB Server | `spawn` in `server.ts` | `main` in `rfdb_server.rs` | `"rfdb-server"` | subprocess | cli_args |
| 7 | RFDBServerBackend -> RFDB | `_send` in `base-client.ts` | `handle_request_with_cancel` | `".grafema/rfdb.sock"` | unix_socket | msgpack |
| 8 | MCP -> RFDB | via RFDBServerBackend | same as #7 | `".grafema/rfdb.sock"` | unix_socket | msgpack |
| 9 | VS Code -> RFDB | `GrafemaClientManager` | `handle_request_with_cancel` | `".grafema/rfdb.sock"` | unix_socket | msgpack/json |
| 10 | VS Code -> GUI Server | `spawnGuiServer` in `mapPanel.ts` | `main` in `gui-server` | `"grafema-gui"` | subprocess | cli_args + http |
| 11 | GUI Server -> RFDB | `RfdbClient.send` in `rfdb_client.rs` | `handle_request_with_cancel` | socket_path | unix_socket | msgpack |
| 12 | Browser -> GUI Server | `fetch` in JS | HTTP handler in gui-server | `"http://localhost:3333/api/*"` | http | json |
| 13 | VS Code -> Orchestrator | `runAnalyze` in `analyzeRunner.ts` | `main` in `main.rs` | `"grafema-orchestrator"` | subprocess | cli_args |
| 14 | CLI Init -> CLI Analyze | `spawn` in `init.ts` | `analyzeAction` | same_binary | subprocess | cli_args |

### Structural Observations

**Hub topology.** RFDB is a hub: boundaries 2, 7, 8, 9, 11 all terminate at the same receiver (`handle_request_with_cancel`) on the same transport (unix_socket) with the same protocol (msgpack). The Bridge Graph makes this star topology explicit.

**Transport distribution.** 6 subprocess bridges, 5 unix_socket bridges, 1 http bridge, 1 env_var bridge, 1 compound (subprocess + http). Subprocess dominates because Grafema's architecture uses process isolation for analysis components.

**Cross-language bridges.** Boundaries 1-6 and 10-13 cross language boundaries (TypeScript to Rust, or browser JS to Rust). These are detectable only when both language analyzers produce graphs that are joined via federation.

**Compound bridges.** Boundary 10 (VS Code -> GUI Server) is compound: the subprocess spawn establishes a process, then HTTP communication occurs within it. The model represents this as two bridges sharing a lifecycle dependency.

**Convergent receivers.** The RFDB server's `handle_request_with_cancel` function is the receiver for 5 distinct bridges. In the Bridge Graph this means 5 incoming bridge edges on a single node -- a pattern that identifies critical infrastructure components.


## 7. Connection to Theoretical Foundations

### Abstract Interpretation Framework

Grafema's theoretical foundations (see `_ai/research/theoretical-foundations.md`) define each analysis as a **semantic projection** -- an abstraction of full program semantics onto a specific concern. The Data Flow Graph projects "where values go." The Call Graph projects "who calls whom." Each projection is an abstract domain in the sense of Cousot and Cousot (1977).

Bridge detection introduces a new projection: the **Communication Domain**. This domain abstracts program behavior onto "who talks to whom across process boundaries." The concrete semantics is the full set of inter-process messages exchanged at runtime. The abstract domain is the set of Bridge tuples detected statically.

The IO effect subtypes are the **abstract values** in this domain. `IO:SOCKET:WRITE` abstracts all concrete socket write operations. `IO:SOCKET:READ` abstracts all concrete socket read operations. The channel identifier refines the abstraction by partitioning IO operations into equivalence classes that share a communication endpoint.

### Bridge Detection as Cross-Domain Join

The critical operation in bridge detection is the **join** of two projections. The sender's effect (`IO:SOCKET:WRITE` on channel X) belongs to process P1's projection. The receiver's effect (`IO:SOCKET:READ` on channel X) belongs to process P2's projection. The bridge is the element in the **intersection** of these two projections -- the point where two otherwise independent abstract domains share a concrete resource.

This is a relational abstract domain (Cousot and Halbwachs, 1978). Rather than analyzing each process in isolation, the Bridge Graph captures relations between processes. The channel equivalence check is the join condition. Soundness of the bridge detection depends on soundness of both the effect classification (are all IO calls annotated?) and the channel extraction (are all channel values resolved?).

### Galois Connection for Bridges

Define:
- Concrete domain C: the set of all inter-process messages exchanged at runtime
- Abstract domain A: the set of Bridge tuples (Sender, Receiver, Channel, Transport, Protocol)
- Abstraction function alpha: maps a concrete message trace to the Bridge tuple that produced it
- Concretization function gamma: maps a Bridge tuple to the set of all possible runtime messages it could produce

The pair (alpha, gamma) forms a Galois connection when the abstraction is sound -- every real message has a corresponding Bridge, and the set of Bridges does not include messages that are impossible. In practice, we achieve an over-approximation: the Bridge set may include spurious elements (false positives), but should not miss real communication (false negatives), modulo the limitations in Section 5.


## 8. Future Extensions

### 8.1 Bidirectional Bridges

Many IPC patterns are request-response: the sender writes a request and reads a response on the same channel. The current model represents this as two bridges (one in each direction). A **Bidirectional Bridge** is a pair of bridges:

```
BB = (B_forward, B_reverse)
where B_forward.Sender = B_reverse.Receiver
  and B_forward.Receiver = B_reverse.Sender
  and B_forward.Channel ≡ B_reverse.Channel
```

All five of Grafema's Unix socket bridges (2, 7, 8, 9, 11) are bidirectional: the client sends a query and receives a response over the same msgpack connection.

### 8.2 Multi-hop Bridges

End-to-end dataflow often crosses multiple boundaries. When a user triggers analysis in VS Code:

```
VS Code --[13]--> Orchestrator --[2]--> RFDB
                              --[3]--> Streaming Plugin
                              --[5]--> Process Pool --[2']--> RFDB
```

A **Multi-hop Bridge** is an ordered sequence of bridges where the receiver of bridge B_i is (or transitively calls) the sender of bridge B_{i+1}. Detecting multi-hop bridges requires composing the Bridge Graph with the intra-process call graph: within each process, trace from the receiver function of one bridge to the sender function of the next.

### 8.3 Dynamic Channel Resolution

For channels determined at runtime (configuration files, command-line arguments, environment variables), static extraction fails. Two approaches:

**Symbolic execution.** Follow the dataflow from channel construction backward to find constraints. If `socketPath` is always `path.join(projectRoot, '.grafema', 'rfdb.sock')`, the channel is partially symbolic but the suffix is constant, which may suffice for matching.

**Runtime sampling.** Instrument the binary to log actual channel values on first run. Use logged values as seeds for static matching in subsequent analyses. This breaks the pure static analysis model but dramatically improves recall.

### 8.4 Confidence Scoring Refinement

The current scoring model (Section 5.4) is additive. A more principled approach uses Bayesian inference: prior probability that two matched functions communicate (based on transport), updated by evidence (channel match quality, protocol agreement, proximity in the dependency graph).

### 8.5 Bridge-Aware Guarantees

Once bridges are detected, they become first-class objects in Grafema's guarantee system. Example guarantees:

- *Every bridge must have both endpoints analyzed.* (Detect dangling bridges where one side is in unanalyzed code.)
- *RFDB bridge count must equal N.* (Regression detection: if a refactor accidentally removes a bridge, the guarantee fails.)
- *No bridge should have confidence below 0.5.* (Quality gate for uncertain detections.)

These are expressible as Datalog rules over the Bridge Graph, consistent with Grafema's existing guarantee infrastructure.

### 8.6 Cross-Language Federation

Bridge detection is most valuable when it spans language boundaries. Grafema analyzes TypeScript, Python, and Rust. Each analyzer produces a graph for its language. The federation protocol (see `_ai/research/federation-protocol.md`) joins these graphs at shard boundaries. Bridge detection operates on the federated graph, matching a TypeScript sender with a Rust receiver -- a capability no single-language analyzer can provide.

This is the endgame for Grafema's "AI should query the graph, not read code" thesis applied to polyglot systems. The graph becomes the single source of truth for how processes communicate, regardless of what language each process is written in.
