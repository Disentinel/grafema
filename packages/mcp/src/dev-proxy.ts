#!/usr/bin/env node
/**
 * Grafema MCP Dev Proxy
 *
 * A thin stdio proxy that sits between Claude Code and the real MCP server.
 * It transparently forwards all JSON-RPC messages, with two exceptions:
 *
 * 1. Intercepts `tools/call` with `name: "reload"` — kills and respawns the
 *    child server process so it picks up new code from dist/ after `pnpm build`.
 *
 * 2. Injects a `reload` tool definition into `tools/list` responses from the
 *    real server.
 *
 * Architecture:
 *   Claude Code  <--stdio-->  dev-proxy  <--stdio-->  real server.js
 *
 * Usage in .claude/mcp.json:
 *   {
 *     "grafema-dev": {
 *       "command": "node",
 *       "args": ["packages/mcp/dist/dev-proxy.js", "--project", "/path/to/project"]
 *     }
 *   }
 *
 * The MCP SDK uses newline-delimited JSON framing (each message is a single
 * JSON object followed by '\n'). No Content-Length headers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Constants ──────────────────────────────────────────────────────────

const RELOAD_TOOL_DEFINITION = {
  name: 'reload',
  description:
    'Hot-reload the MCP server (restarts the process to pick up new dist/ code after pnpm build)',
  inputSchema: { type: 'object' as const, properties: {} },
};

/** Path to the real MCP server entry point (co-located in dist/) */
const SERVER_SCRIPT = join(__dirname, 'server.js');

/** All CLI args passed to this proxy are forwarded to the child server */
const CHILD_ARGS = process.argv.slice(2);

// ── Logging (stderr only — stdout is the JSON-RPC channel) ────────────

function log(msg: string): void {
  process.stderr.write(`[dev-proxy] ${msg}\n`);
}

// ── Child Process Management ───────────────────────────────────────────

let child: ChildProcess | null = null;
let childReady = false;
/** Messages buffered while child is (re)starting */
let pendingMessages: string[] = [];
/** Track in-flight requests so we can send error responses on crash */
const inflightRequests = new Map<string | number, boolean>();

/**
 * Spawn the real MCP server as a child process.
 * stdin/stdout are piped for JSON-RPC; stderr is inherited for debug logs.
 */
function spawnChild(): void {
  log(`Spawning child: node ${SERVER_SCRIPT} ${CHILD_ARGS.join(' ')}`);

  child = spawn('node', [SERVER_SCRIPT, ...CHILD_ARGS], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  childReady = true;

  // ── Child stdout → proxy stdout (with tools/list injection) ──
  let childBuffer = '';

  child.stdout!.on('data', (chunk: Buffer) => {
    childBuffer += chunk.toString('utf8');

    // Process complete newline-delimited messages
    let newlineIdx: number;
    while ((newlineIdx = childBuffer.indexOf('\n')) !== -1) {
      const line = childBuffer.slice(0, newlineIdx);
      childBuffer = childBuffer.slice(newlineIdx + 1);

      if (line.trim().length === 0) continue;

      try {
        const msg = JSON.parse(line);

        // Remove from in-flight tracking if this is a response
        if ('id' in msg && msg.id !== undefined) {
          inflightRequests.delete(msg.id);
        }

        // Inject reload tool into tools/list responses
        if (isToolsListResponse(msg)) {
          msg.result.tools.push(RELOAD_TOOL_DEFINITION);
        }

        process.stdout.write(JSON.stringify(msg) + '\n');
      } catch {
        // If we can't parse it, forward raw (shouldn't happen with well-formed server)
        process.stdout.write(line + '\n');
      }
    }
  });

  // ── Child exit handling ──
  child.on('exit', (code, signal) => {
    log(`Child exited: code=${code}, signal=${signal}`);
    childReady = false;

    // Send error responses for any in-flight requests
    for (const [id] of inflightRequests) {
      sendErrorResponse(id, -32000, 'MCP server process crashed');
    }
    inflightRequests.clear();

    child = null;

    // Auto-restart unless we're shutting down
    if (!shuttingDown) {
      log('Auto-restarting child in 500ms...');
      setTimeout(() => {
        spawnChild();
        flushPendingMessages();
      }, 500);
    }
  });

  child.on('error', (err) => {
    log(`Child spawn error: ${err.message}`);
    childReady = false;
    child = null;
  });

  // Flush any messages that arrived while child was restarting
  flushPendingMessages();
}

function flushPendingMessages(): void {
  if (!child || !childReady || pendingMessages.length === 0) return;
  log(`Flushing ${pendingMessages.length} pending message(s)`);
  for (const msg of pendingMessages) {
    child.stdin!.write(msg + '\n');
  }
  pendingMessages = [];
}

function killChild(): Promise<void> {
  return new Promise((resolve) => {
    if (!child) {
      resolve();
      return;
    }

    const c = child;
    // Prevent auto-restart during intentional reload
    const onExit = () => {
      child = null;
      childReady = false;
      resolve();
    };

    c.once('exit', onExit);
    c.kill('SIGTERM');

    // Force kill after 3 seconds
    setTimeout(() => {
      if (c.exitCode === null && c.signalCode === null) {
        log('Child did not exit after SIGTERM, sending SIGKILL');
        c.kill('SIGKILL');
      }
    }, 3000);
  });
}

// ── JSON-RPC Helpers ───────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isToolsCallReload(msg: JsonRpcRequest): boolean {
  return (
    msg.method === 'tools/call' &&
    msg.params != null &&
    (msg.params as Record<string, unknown>).name === 'reload'
  );
}

function isToolsListResponse(msg: unknown): msg is JsonRpcResponse & {
  result: { tools: Array<{ name: string }> };
} {
  const m = msg as Record<string, unknown>;
  if (!m || typeof m !== 'object') return false;
  if (!('result' in m) || !m.result) return false;
  const result = m.result as Record<string, unknown>;
  return Array.isArray(result.tools);
}

function sendSuccessResponse(id: string | number, result: unknown): void {
  const response: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    result,
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendErrorResponse(
  id: string | number,
  code: number,
  message: string
): void {
  const response: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

// ── Reload Handler ─────────────────────────────────────────────────────

async function handleReload(requestId: string | number): Promise<void> {
  log('Reload requested — restarting child process...');

  try {
    // Suppress auto-restart during intentional kill
    shuttingDown = true;
    await killChild();
    shuttingDown = false;

    spawnChild();

    sendSuccessResponse(requestId, {
      content: [
        {
          type: 'text',
          text: 'MCP server reloaded successfully. New dist/ code is now active.',
        },
      ],
    });
  } catch (err) {
    shuttingDown = false;
    const message = err instanceof Error ? err.message : String(err);
    log(`Reload failed: ${message}`);
    sendErrorResponse(requestId, -32000, `Reload failed: ${message}`);
  }
}

// ── Main: stdin → child (with reload interception) ─────────────────────

let shuttingDown = false;
let stdinBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinBuffer += chunk;

  let newlineIdx: number;
  while ((newlineIdx = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, newlineIdx);
    stdinBuffer = stdinBuffer.slice(newlineIdx + 1);

    if (line.trim().length === 0) continue;

    try {
      const msg = JSON.parse(line) as JsonRpcRequest;

      // Intercept reload tool call
      if (msg.method === 'tools/call' && isToolsCallReload(msg)) {
        if (msg.id !== undefined) {
          void handleReload(msg.id);
        }
        continue;
      }

      // Track request IDs for crash error responses
      if ('id' in msg && msg.id !== undefined && 'method' in msg) {
        inflightRequests.set(msg.id, true);
      }

      // Forward to child
      if (child && childReady) {
        child.stdin!.write(line + '\n');
      } else {
        pendingMessages.push(line);
      }
    } catch {
      // Not valid JSON — forward raw (shouldn't happen with well-formed client)
      if (child && childReady) {
        child.stdin!.write(line + '\n');
      } else {
        pendingMessages.push(line);
      }
    }
  }
});

// ── Graceful Shutdown ──────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down...');

  await killChild();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdin.on('end', () => void shutdown());

// ── Start ──────────────────────────────────────────────────────────────

log('Dev proxy starting');
spawnChild();
