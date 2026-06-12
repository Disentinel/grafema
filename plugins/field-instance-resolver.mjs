#!/usr/bin/env node
/**
 * Field Instance Resolver — Grafema batch plugin
 *
 * Resolves CALLs whose receiver is an instance attribute initialized to a
 * known library constructor. Closes the gap exposed by gs-115b's deep dive
 * of dpc-messenger, where 6/9 HTTP calls were invisible because they go
 * through `self.http_client.<method>(...)` after `self.http_client =
 * httpx.AsyncClient(...)` in `__init__`.
 *
 * Strategy (per-file):
 *   1. Index VARIABLE nodes with kind="instance_variable" — these are
 *      `self.<name>` declarations. Group by file → name → [VARIABLE].
 *   2. Find CALL nodes whose `receiver` matches one of the instance
 *      attribute names in that file. These are candidates: e.g.
 *      `self.http_client.get(...)`, where Python analyzer flattens
 *      `receiver` to just the attribute name (`http_client`).
 *   3. For each candidate file, scan the source for `self.<name> = <ctor>(...)`
 *      statements (regex over the actual .py file is cheap and the only path
 *      that works today — the Python analyzer does not emit ASSIGNED_FROM
 *      edges for instance-attribute assignments, so the graph alone cannot
 *      resolve the constructor; see "Plan B" below for the long-term fix).
 *   4. Resolve `<ctor>` against per-file imports (also regex-extracted) into
 *      a fully-qualified library symbol (e.g. `httpx.AsyncClient`).
 *   5. For each candidate CALL whose method is in the library's known method
 *      set, write back a `READS_FROM[kind=field_receiver]` edge from the
 *      CALL to the field VARIABLE, with edge metadata recording the resolved
 *      library, subtype, ctor and method. Existing batch plugins (method-
 *      call-resolver, ipc-bridge-detector) all enrich via edges only — node
 *      metadata mutation isn't part of the public RFDBClient API today, so
 *      enrichment data lives on the edge.
 *
 * Consumer pattern (Cypher):
 *
 *   MATCH (c:CALL)-[r:READS_FROM]->(v:VARIABLE)
 *   WHERE r.kind = "field_receiver"
 *   RETURN c.file, c.name, r.resolved_library, r.resolved_subtype
 *
 * Output: stderr-only progress + final counts. The graph is mutated in place.
 *
 * Environment:
 *   RFDB_SOCKET   — path to RFDB unix socket (required)
 *   RFDB_DATABASE — database name (optional)
 *   PROJECT_ROOT  — absolute path to the analyzed project (required for
 *                   source scanning; defaults to CWD).
 *   DRY_RUN       — if "1" or "true", classify but do not write edges/metadata
 */

import { RFDBClient } from '../packages/rfdb/dist/client.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Library constructor → classification.
 * `methods` lists the method names that, when called on an instance of this
 * library, should be classified by `subtype`. Method-set membership is the
 * filter that prevents over-eager tagging of e.g. `self.http_client.foo()`
 * where `foo` is some unrelated method.
 */
const LIBRARY_PATTERNS = {
  // HTTP clients
  'httpx.Client':        { library: 'httpx',       subtype: 'IO:HTTP:REQUEST', methods: HTTP_METHODS() },
  'httpx.AsyncClient':   { library: 'httpx',       subtype: 'IO:HTTP:REQUEST', methods: HTTP_METHODS() },
  'requests.Session':    { library: 'requests',    subtype: 'IO:HTTP:REQUEST', methods: HTTP_METHODS() },
  'aiohttp.ClientSession':{library: 'aiohttp',    subtype: 'IO:HTTP:REQUEST', methods: HTTP_METHODS() },
  // Sockets
  'socket.socket':            { library: 'socket', subtype: 'IO:SOCKET',  methods: SOCKET_METHODS() },
  'socket.create_connection': { library: 'socket', subtype: 'IO:SOCKET:CONNECT', methods: SOCKET_METHODS() },
  'socket.create_server':     { library: 'socket', subtype: 'IO:SOCKET:LISTEN',  methods: SOCKET_METHODS() },
  // WebSocket clients (return value of websockets.connect — async ctx mgr)
  'websockets.connect':       { library: 'websockets', subtype: 'IO:WEBSOCKET', methods: WS_METHODS() },
  'websockets.WebSocketClientProtocol': { library: 'websockets', subtype: 'IO:WEBSOCKET', methods: WS_METHODS() },
  // Subprocess (Popen instance)
  'subprocess.Popen': { library: 'subprocess', subtype: 'IO:PROCESS:SPAWN', methods: new Set(['communicate','wait','poll','kill','terminate','send_signal']) },
};

function HTTP_METHODS()   { return new Set(['get','post','put','delete','patch','head','options','request','stream','send']); }
function SOCKET_METHODS() { return new Set(['connect','bind','listen','accept','send','sendall','sendto','recv','recvfrom','close','shutdown']); }
function WS_METHODS()     { return new Set(['send','recv','send_text','send_bytes','send_json','recv_text','close','ping','pong']); }

// ── Setup ───────────────────────────────────────────────────────────────────

const socketPath = process.env.RFDB_SOCKET;
const dbName = process.env.RFDB_DATABASE;
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const dryRun = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');

if (!socketPath) {
  console.error('[field-instance-resolver] RFDB_SOCKET not set');
  process.exit(1);
}

const client = new RFDBClient(socketPath, 'field-instance-resolver');

const safeParse = (s) => {
  if (!s) return {};
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return {}; }
};

try {
  await client.connect();
  if (dbName) await client.openDatabase(dbName);

  // Step 1: Index instance_variable VARIABLE nodes per file
  console.error('[field-instance-resolver] Indexing instance variables...');
  const fieldsByFile = new Map(); // file -> Map(fieldName -> [variableNodeId])
  let varCount = 0;
  for await (const v of client.queryNodes({ type: 'VARIABLE' })) {
    const meta = safeParse(v.metadata);
    if (meta.kind !== 'instance_variable') continue;
    if (!v.file || !v.file.endsWith('.py')) continue;
    if (!v.name) continue;
    if (!fieldsByFile.has(v.file)) fieldsByFile.set(v.file, new Map());
    const map = fieldsByFile.get(v.file);
    if (!map.has(v.name)) map.set(v.name, []);
    map.get(v.name).push(String(v.id));
    varCount++;
  }
  console.error(`[field-instance-resolver]   ${varCount} instance_variable nodes across ${fieldsByFile.size} files`);

  // Step 2: For every Python file with instance variables, scan the source to
  // discover `self.<field> = <ctor>(...)` and `import` lines. We need the
  // source because the Python analyzer does not emit ASSIGNED_FROM edges for
  // instance-attribute assignments today — see "Plan B" in the design doc.
  console.error('[field-instance-resolver] Scanning source for ctor assignments...');
  const fieldCtor = new Map();   // file -> Map(field -> resolvedSymbol)
  for (const file of fieldsByFile.keys()) {
    const abs = join(projectRoot, file);
    if (!existsSync(abs)) continue;
    let text;
    try { text = readFileSync(abs, 'utf-8'); } catch { continue; }

    // Build per-file import alias map: localName -> fullDottedSymbol
    /** @type {Map<string, string>} */
    const aliases = new Map();
    for (const line of text.split('\n')) {
      let m;
      if ((m = line.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/))) {
        const full = m[1];
        const local = m[2] || full.split('.')[0];
        aliases.set(local, m[2] ? full : full); // "import httpx" → httpx; "import x.y as z" → z=x.y
      } else if ((m = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/))) {
        const from = m[1];
        for (const part of m[2].split(',')) {
          const mm = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?/);
          if (!mm) continue;
          const imported = mm[1];
          const local = mm[2] || imported;
          aliases.set(local, `${from}.${imported}`);
        }
      }
    }

    // Resolve a dotted reference written in source against the alias map
    const resolve = (ref) => {
      const parts = ref.split('.');
      const head = parts[0];
      const tail = parts.slice(1).join('.');
      const headFull = aliases.get(head) || head;
      return tail ? `${headFull}.${tail}` : headFull;
    };

    // Match `self.<field> = (await )?<ctor>(...)` — single-line, single-stmt.
    // We deliberately do NOT match multi-line expressions to keep the regex
    // honest; chained constructors (`httpx.AsyncClient(...).get(...)`) won't
    // round-trip but are rare in __init__.
    const re = /(?:^|\n)\s*self\.(\w+)\s*=\s*(?:await\s+)?([\w.]+)\s*\(/g;
    const ctorMap = new Map();
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const field = mm[1];
      const ctor = mm[2];
      const resolved = resolve(ctor);
      ctorMap.set(field, resolved);
    }
    if (ctorMap.size > 0) fieldCtor.set(file, ctorMap);
  }
  console.error(`[field-instance-resolver]   ctor assignments resolved in ${fieldCtor.size} files`);

  // Step 3: Walk CALL nodes whose receiver matches a known field. For each
  // match, check that we already produced an edge in a previous run (the
  // edge itself is the idempotency marker — re-running won't double-write
  // because we test for presence first).
  console.error('[field-instance-resolver] Classifying field-method calls...');
  let scanned = 0, classified = 0, skippedAlreadyTagged = 0, skippedUnknown = 0;
  const newEdges = [];

  for await (const call of client.queryNodes({ type: 'CALL' })) {
    if (!call.file || !call.file.endsWith('.py')) continue;
    scanned++;
    const meta = safeParse(call.metadata);
    const recv = meta.receiver;
    if (!recv) continue;

    const ctorMap = fieldCtor.get(call.file);
    if (!ctorMap) continue;
    const ctor = ctorMap.get(recv);
    if (!ctor) continue;

    // Match against LIBRARY_PATTERNS. Try direct, then suffix-match (handles
    // `from httpx import AsyncClient` → resolved as "httpx.AsyncClient" by
    // the alias resolver, which is what the pattern key expects).
    let pattern = LIBRARY_PATTERNS[ctor];
    if (!pattern) {
      // Try last-two-segments fallback (e.g. "x.httpx.Client" → "httpx.Client")
      const parts = ctor.split('.');
      if (parts.length >= 2) {
        const tail = parts.slice(-2).join('.');
        pattern = LIBRARY_PATTERNS[tail];
      }
    }
    if (!pattern) { skippedUnknown++; continue; }

    if (!pattern.methods.has(call.name)) continue;

    // Idempotency: skip if we already wrote a field_receiver edge for this CALL
    const callId = String(call.id);
    const existingOut = await client.getOutgoingEdges(callId);
    const already = existingOut.some(e => {
      if (e.type !== 'READS_FROM') return false;
      const em = safeParse(e.metadata);
      return em.kind === 'field_receiver';
    });
    if (already) { skippedAlreadyTagged++; continue; }

    classified++;

    // Pick the representative field VARIABLE to link to. Existing batch
    // plugins enrich purely via edges (see ipc-bridge-detector) —
    // `client.updateNode` is not part of the public RFDBClient API, so all
    // enrichment data lives on the edge.
    const fieldVars = fieldsByFile.get(call.file)?.get(recv) || [];
    if (fieldVars.length === 0) continue;

    newEdges.push({
      src: callId,
      dst: fieldVars[0],
      type: 'READS_FROM',
      metadata: JSON.stringify({
        _source: 'field-instance-resolver',
        kind: 'field_receiver',
        resolved_library: pattern.library,
        resolved_subtype: pattern.subtype,
        resolved_ctor: ctor,
        resolved_method: call.name,
      }),
    });
  }

  console.error(
    `[field-instance-resolver]   scanned=${scanned} classified=${classified} ` +
    `skipped_already=${skippedAlreadyTagged} skipped_unknown_ctor=${skippedUnknown}`,
  );

  if (dryRun) {
    console.error('[field-instance-resolver] DRY_RUN — not writing edges');
  } else if (newEdges.length > 0) {
    const BATCH = 500;
    console.error(`[field-instance-resolver] Adding ${newEdges.length} READS_FROM[kind=field_receiver] edges...`);
    for (let i = 0; i < newEdges.length; i += BATCH) {
      await client.addEdges(newEdges.slice(i, i + BATCH));
    }
  }

  console.error('[field-instance-resolver] Done.');
  await client.close();
} catch (err) {
  console.error(`[field-instance-resolver] Error: ${err && err.stack ? err.stack : err}`);
  try { await client.close(); } catch { /* ignore */ }
  process.exit(1);
}
