# Bridge Detection Methodology

**Status:** Reference / Active
**Date:** 2026-03-30
**Scope:** Practical recipe for detecting and registering IPC bridges in the Grafema graph

## 1. Overview

A "bridge" in Grafema is a cross-process or cross-language communication boundary: a point where one program sends data and another receives it, but no direct function call exists in the code graph. Without explicit bridge detection, these boundaries appear as dead ends — the graph shows a function calling `socket.write()` but has no edge to the server-side handler that receives the message.

Bridge detection closes this gap by creating `CALLS_REMOTE` edges between the sender and receiver. These edges carry metadata describing the transport, protocol, serialization format, and channel identity, allowing `trace_dataflow` and `find_calls` to follow data across process boundaries.

This document is a step-by-step recipe for identifying new bridges, annotating them in the effects taxonomy, and wiring them into the `ipc-bridge-detector` plugin. It is intended for both human developers and AI agents working on Grafema.

## 2. Step-by-Step Recipe

### Step 1: Identify the Transport

Determine the communication mechanism. Each transport has a distinct shape in code:

| Transport | Typical API (sender side) | Typical API (receiver side) |
|-----------|--------------------------|----------------------------|
| Unix socket | `net.connect(path)`, `UnixStream::connect(path)` | `UnixListener::bind(path)`, `net.createServer()` |
| HTTP | `fetch(url)`, `http.request(url)` | `.route(path, handler)`, `app.get(path, handler)` |
| Subprocess | `spawn(binary, args)`, `Command::new(binary)` | `fn main()`, entry point of spawned binary |
| Environment variable | `.env("KEY", value)` on spawn call | `process.env.KEY`, `std::env::var("KEY")` |
| Shared file | `fs.writeFileSync(path, data)` | `fs.readFileSync(path)`, `std::fs::read(path)` |
| Message queue | `channel.sendToQueue(name, msg)` | `channel.consume(name, handler)` |

Also note the serialization: msgpack, JSON, NDJSON, protobuf, CLI args, or plain text. This goes into the bridge metadata.

### Step 2: Find the Sender Code

Locate the function or method that initiates communication. Key questions:

- **What function calls the transport API?** Not the transport call itself (e.g., `socket.write`), but the application-level method that prepares and sends the message (e.g., `BaseRFDBClient._send()`).
- **What are its arguments?** Which argument identifies the "channel" — the socket path, URL, binary name, or env var key?
- **What effect does it produce?** Map to a taxonomy IO subtype: `IO:SOCKET:WRITE`, `IO:PROCESS:SPAWN`, `IO:HTTP:REQUEST`, `IO:ENV:SET`.

Use `find_calls(name="write", className="Socket")` or `find_nodes(type="METHOD", name="_send")` to locate candidates in the graph. For HTTP senders, search for CALL nodes targeting `fetch` or `http.request`.

### Step 3: Find the Receiver Code

Locate the function or method that handles incoming communication. Key questions:

- **Is it an entry point?** Subprocess receivers are typically `main()` functions. Socket receivers are connection handlers. HTTP receivers are route handlers.
- **Does it have a dispatch layer?** Many receivers have an outer accept loop and an inner dispatcher. The bridge should point to the dispatcher (the function that interprets the message), not the accept loop.
- **What effect does it produce?** `IO:SOCKET:READ`, `IO:PROCESS:STDIN_READ`, `IO:HTTP:LISTEN`, `IO:ENV:READ`.

Use `find_nodes(type="FUNCTION", name="handle_request*")` or `get_file_overview(file="rfdb_server.rs")` to find candidates.

### Step 4: Determine the Channel Identity

The channel is the value that links sender to receiver — the shared "address" both sides agree on. It determines how Grafema matches a send to a receive.

| Transport | Channel identity | Example |
|-----------|-----------------|---------|
| Unix socket | Socket file path | `.grafema/rfdb.sock` |
| HTTP | URL path pattern | `/api/stats` |
| Subprocess | Binary name | `grafema-orchestrator` |
| Environment variable | Env var name | `RFDB_SOCKET` |
| Shared file | File path | `.grafema/analysis-profile.jsonl` |

**Static vs. dynamic:** If the channel is a hardcoded string literal, extraction is straightforward. If it is computed at runtime (e.g., `path.join(dir, 'rfdb.sock')`), use the best available approximation and mark the bridge as `LOW_CONFIDENCE`. A partial match (suffix, pattern) is better than no bridge.

### Step 5: Update Effects-DB (if needed)

If the transport library or API is not yet annotated in `effects-db/`:

1. Check `effects-db/taxonomy.yaml` for existing IO subtypes. As of v1, IO is a flat category; subtypes (`IO:SOCKET:WRITE`, etc.) are future extensions documented in the "Future extensions" comment.
2. If the transport package is new (e.g., `amqplib` for message queues), create a YAML file in `effects-db/packages/` following the existing format (see `effects-db/packages/commander.yaml` for structure).
3. Annotate the send/receive methods with their effects and include `channel_hint` metadata where applicable.

### Step 6: Add Bridge Definition

Add the bridge to `plugins/ipc-bridge-detector.mjs` in the `BRIDGES` array. Each entry has three parts:

```javascript
{
  name: 'descriptive-name',           // unique identifier
  description: 'What this bridge connects',
  sender: {
    type: 'METHOD',                   // or 'FUNCTION'
    name: '_send',                    // graph node name
    filePattern: 'base-client.ts',    // substring match on file path
  },
  receiver: {
    type: 'FUNCTION',
    name: 'handle_request_with_cancel',
    filePattern: 'rfdb_server.rs',
  },
  metadata: {
    transport: 'unix_socket',         // transport type
    protocol: 'msgpack',             // serialization format
    channel: '.grafema/rfdb.sock',   // channel identity
  },
}
```

The plugin queries the graph for nodes matching `sender` and `receiver` specs, then creates a `CALLS_REMOTE` edge with the metadata attached.

### Step 7: Verify

1. Rebuild: `pnpm build`
2. Re-analyze: `grafema analyze --force`
3. Check the edge exists: `find_calls(name="handle_request_with_cancel")` should show the CALLS_REMOTE from the sender.
4. Trace forward from sender: `trace_dataflow(source="_send", direction="forward")` should cross the bridge.
5. Trace backward from receiver: `trace_dataflow(source="handle_request_with_cancel", direction="backward")` should reach the sender.

If the edge does not appear, check:
- Are both sender and receiver nodes present in the graph? (`find_nodes` by name and file)
- Does `filePattern` match? It is a substring check, not a glob.
- Did the plugin actually run? Check orchestrator output for `[ipc-bridge-detector]` log lines.

## 3. Worked Examples

### Example A: Unix Socket — RFDB Client to Server

**Transport:** Unix domain socket with msgpack-framed protocol (4-byte length prefix + MessagePack payload).

**Sender:** `BaseRFDBClient._send()` in `packages/rfdb/ts/base-client.ts`. This abstract method is implemented by `RFDBClient` (unix socket transport) which serializes the command to msgpack and writes it to a `net.Socket` connected to the RFDB server socket.

**Receiver:** `handle_request_with_cancel()` in `packages/rfdb-server/src/bin/rfdb_server.rs`. Reads the length-prefixed msgpack frame from `UnixStream`, deserializes the command, dispatches to the graph engine, and writes the response back.

**Channel:** `.grafema/rfdb.sock` — passed to `RFDBServerBackend` constructor, which passes it to `RFDBClient` as the socket path, and to `rfdb-server` as the `--socket` CLI argument.

**Effect pair:** IO:SOCKET:WRITE (sender writes msgpack frame) and IO:SOCKET:READ (receiver reads from UnixStream).

**Bridge definition:**
```javascript
{
  name: 'rfdb-unix-socket',
  sender: { type: 'METHOD', name: '_send', filePattern: 'base-client.ts' },
  receiver: { type: 'FUNCTION', name: 'handle_request_with_cancel', filePattern: 'rfdb_server.rs' },
  metadata: { transport: 'unix_socket', protocol: 'msgpack', channel: '.grafema/rfdb.sock' },
}
```

### Example B: Subprocess — CLI spawns Orchestrator

**Transport:** Subprocess via `child_process.spawn()`. The CLI spawns the Rust orchestrator binary as a child process, passing configuration through CLI arguments.

**Sender:** `analyzeAction()` in `packages/cli/src/commands/analyzeAction.ts`. Calls `spawn(orchestratorBinary, args)` with the resolved path to `grafema-orchestrator`. Arguments include `--config`, `--rfdb-socket`, `--db-name`, and language flags.

**Receiver:** `fn main()` in `packages/grafema-orchestrator/src/main.rs`. Parses CLI arguments via `clap`, connects to RFDB, runs the analysis pipeline (discovery, parsing, analysis, resolution, plugin execution), and exits.

**Channel:** Binary name `grafema-orchestrator`, resolved by `findOrchestratorBinary()` which checks `GRAFEMA_ORCHESTRATOR` env var, then local and global installation paths.

**Effect pair:** IO:PROCESS:SPAWN (sender creates child process) and entry-point linkage (receiver is the binary's `main`). The orchestrator does not read stdin — it takes CLI args — but the structural relationship is the same: one process creates another.

**Bridge definition:**
```javascript
{
  name: 'cli-orchestrator-spawn',
  sender: { type: 'FUNCTION', name: 'analyzeAction', filePattern: 'analyzeAction.ts' },
  receiver: { type: 'FUNCTION', name: 'main', filePattern: 'grafema-orchestrator/src/main.rs' },
  metadata: { transport: 'subprocess', protocol: 'cli_args', channel: 'grafema-orchestrator' },
}
```

### Example C: HTTP — Browser to GUI Server

**Transport:** HTTP GET requests from browser JavaScript to an Axum HTTP server.

**Sender:** `fetch()` calls in `packages/gui/public/hex-topology.html` and other GUI pages. For example, `fetch(\`/api/search?q=${query}\`)` and `fetch(\`/api/node?index=${idx}\`)`.

**Receiver:** Route handlers in `packages/gui-server/src/main.rs`. The Axum router defines routes like `.route("/api/stats", get(api_stats))`, `.route("/api/node", get(api_node))`, `.route("/api/search", get(api_search))`.

**Channel:** URL path patterns — `/api/stats`, `/api/node`, `/api/search`, `/api/hex-stream`, `/api/hex-batch/{batch_id}`. Each path matches one route handler.

**Effect pair:** IO:HTTP:REQUEST (browser fetch) and IO:HTTP:LISTEN (Axum route handler).

**Bridge definition** (one per route, or a single bridge for the API surface):
```javascript
{
  name: 'gui-http-api',
  sender: { type: 'CALL', name: 'fetch', filePattern: 'hex-topology.html' },
  receiver: { type: 'FUNCTION', name: 'api_stats', filePattern: 'gui-server/src/main.rs' },
  metadata: { transport: 'http', protocol: 'json', channel: '/api/stats' },
}
```

Note: HTTP bridges often have a fan-out pattern — many sender call sites hitting different routes. Consider creating one bridge per route or one aggregate bridge with a `routes` metadata list.

### Example D: Environment Variable — Orchestrator to Batch Plugin

**Transport:** Environment variable set on a spawned subprocess. The orchestrator passes the RFDB socket path to batch plugins via `RFDB_SOCKET` env var.

**Sender:** `run_batch_plugin()` in `packages/grafema-orchestrator/src/plugin.rs`. The spawn call sets `.env("RFDB_SOCKET", socket_path.as_os_str())` and `.env("RFDB_DATABASE", db_name)`.

**Receiver:** Batch plugins like `plugins/ipc-bridge-detector.mjs` and `plugins/method-call-resolver.mjs`. They read `process.env.RFDB_SOCKET` to connect to the RFDB server.

**Channel:** Environment variable name `RFDB_SOCKET`. The value is the socket path, but the channel identity is the key name — it is the contract both sides agree on.

**Effect pair:** IO:ENV:SET (orchestrator sets env var on child) and IO:ENV:READ (plugin reads env var).

**Bridge definition:**
```javascript
{
  name: 'orchestrator-plugin-env',
  sender: { type: 'FUNCTION', name: 'run_batch_plugin', filePattern: 'plugin.rs' },
  receiver: { type: 'MODULE', name: 'ipc-bridge-detector', filePattern: 'ipc-bridge-detector.mjs' },
  metadata: { transport: 'env_var', protocol: 'string', channel: 'RFDB_SOCKET' },
}
```

Note: this is a meta-bridge — the env var does not carry application data, it carries configuration that enables a second bridge (the plugin connecting to RFDB over unix socket). Both bridges should exist in the graph for complete traceability.

## 4. Channel Extraction Techniques

Given a graph with sender and receiver nodes already identified, how do you extract the channel identity programmatically?

### Socket Path

Trace the argument of `net.connect()` or `UnixStream::connect()` backward through data flow:

```
trace_dataflow(source="socketPath", file="packages/rfdb/ts/client.ts", direction="backward")
```

Follow ASSIGNED_FROM edges until you reach a string literal or a constructor parameter. If the chain passes through a config object, the channel is "dynamic but deterministic" — the config file pins it.

### Binary Name

The first argument to `spawn()` or `Command::new()` is the binary path. Trace it backward:

```
trace_dataflow(source="orchestratorBinary", file="analyzeAction.ts", direction="backward")
```

This typically resolves to a `findOrchestratorBinary()` call, which checks env vars and known paths. The channel identity is the binary basename (e.g., `grafema-orchestrator`), not the full path. Match it against `services[].entryPoint` in `grafema.config.yaml` if service discovery is configured.

### URL Pattern

For `fetch(url)` calls, trace the URL argument. It is often a template literal:

```
find_nodes(type="CALL", name="fetch", file="hex-topology.html")
```

Extract the string literal or template from the CALL node's arguments. On the receiver side, search for route definitions:

```
find_nodes(type="CALL", name="route", file="gui-server")
```

Route handlers typically appear as `.route("/api/path", get(handler_fn))`. Match URL prefixes between sender and receiver.

### Environment Variable Name

Search for `.env("KEY"` patterns in spawn calls (sender side) and `process.env.KEY` reads (receiver side):

```
find_nodes(type="CALL", name="env")       # Rust side: Command.env()
find_nodes(type="PROPERTY_ACCESS", name="RFDB_SOCKET")  # JS side: process.env.RFDB_SOCKET
```

The match is by exact key name string. This is almost always static.

## 5. Edge Cases and Limitations

### Dynamic Channels

When the channel is computed at runtime (e.g., socket path from `path.join(tempDir, 'test.sock')`), the graph cannot resolve it to a static value. Strategy:

- Mark the bridge with `confidence: "LOW"` in metadata.
- Use the best approximation: if the pattern is `*.sock`, note that. If it always ends with `rfdb.sock`, use that suffix.
- A low-confidence bridge is better than no bridge — it tells the agent "something crosses here" even if the exact target is uncertain.

### Intermediate Proxies

When A talks to B through a proxy (A sends to proxy, proxy forwards to B), this is two bridges, not one:

1. A CALLS_REMOTE proxy
2. proxy CALLS_REMOTE B

Detect each hop independently. The proxy's receiver and sender may be in the same file (accept on one side, forward on the other). Use `get_file_overview` on the proxy to find both functions.

### Same-Binary Self-Spawn

Some tools spawn themselves with different arguments (e.g., `grafema analyze` spawning `grafema` in worker mode). The binary name alone is not enough to distinguish roles. Strategy:

- Match by argument pattern: the parent passes `--worker` or a subcommand that the child uses as its entry branch.
- Create the bridge from the spawn call to the specific handler for that subcommand, not to `main()`.

### Multiple Services on Same Socket

If multiple logical services share a transport (e.g., multiplexed protocol on one socket), disambiguate by:

- Protocol version or client ID in the handshake.
- Command type field in the message envelope.
- Create one bridge per logical service, all pointing to the same socket but with different `service` metadata.

### Missing Nodes

If either sender or receiver is in a language Grafema does not yet analyze (e.g., Go, Ruby), the node will not exist in the graph. The bridge definition will fail silently — the plugin logs a warning and skips. Options:

- Create a synthetic node (type `EXTERNAL`) representing the missing endpoint.
- Add a stub entry to `effects-db` so the manifest captures the interface even without full analysis.
- Track the gap in `_ai/gaps.md` for future language support.

### One-to-Many and Many-to-One

HTTP APIs commonly have many clients hitting one server. Create one bridge per distinct caller file (or aggregate with `callerPattern` if there are dozens). Similarly, pub-sub patterns have one publisher and many subscribers — one bridge per subscriber.
