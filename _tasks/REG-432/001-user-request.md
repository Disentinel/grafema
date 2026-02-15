# REG-432: Socket Connection Analysis (Unix/TCP)

## Goal

Analyze socket connections in code — Unix sockets (`net.connect`, `net.createConnection` with path) and TCP sockets (`net.connect` with host:port).

**Motivation:** Grafema itself communicates with RFDB via Unix socket. Dogfooding — we should see our own connections in the graph.

## Node Types

* `socket:connection` — client-side socket connection (outgoing)
* `socket:server` — server-side socket listener (`net.createServer`)

## Metadata

`socket:connection`:
* `protocol`: `unix` | `tcp`
* `path` (for unix sockets)
* `host`, `port` (for tcp)
* `library`: `net` | `ipc` | custom

`socket:server`:
* `protocol`: `unix` | `tcp`
* `path` or `host`/`port`
* event handlers (`connection`, `data`, `error`)

## Architecture

Follow existing HTTP pattern:

1. **SocketAnalyzer** (ANALYSIS phase) — detect `net.connect()`, `net.createConnection()`, `net.createServer()`, `new net.Socket()` patterns, create nodes
2. **SocketConnectionEnricher** (ENRICHMENT phase) — link `socket:connection` ↔ `socket:server` by matching path/port

## Detection Patterns

```js
// Unix socket client
net.connect({ path: '/tmp/app.sock' })
net.createConnection('/var/run/rfdb.sock')

// TCP client
net.connect({ port: 3000, host: 'localhost' })
new net.Socket().connect(port, host)

// Server
net.createServer((socket) => { ... }).listen('/tmp/app.sock')
net.createServer().listen(3000)
```

## Acceptance Criteria

- [ ] `socket:connection` and `socket:server` node types defined in types package
- [ ] SocketAnalyzer detects Node.js `net` module patterns
- [ ] Enricher links client ↔ server connections
- [ ] Grafema's own RFDB socket connection visible in graph (dogfooding validation)
- [ ] Tests cover unix socket, tcp socket, server patterns
