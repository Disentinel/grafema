/**
 * MCP Server Utilities
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import type { PaginationParams, ToolResult } from './types.js';

// === CONSTANTS ===
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 500;
export const DEFAULT_RESPONSE_SIZE_LIMIT = 100_000;

// === LOGGING ===
let logsDir: string | null = null;
const MAX_LOG_FILES = 7; // Keep logs for 7 days

function getLogFilePath(): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const dir = logsDir || '/tmp';
  return join(dir, `mcp-${date}.log`);
}

function cleanupOldLogs(): void {
  if (!logsDir || !existsSync(logsDir)) return;

  try {
    const files = readdirSync(logsDir)
      .filter(f => f.startsWith('mcp-') && f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: join(logsDir!, f),
        mtime: statSync(join(logsDir!, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    // Remove files beyond MAX_LOG_FILES
    for (const file of files.slice(MAX_LOG_FILES)) {
      unlinkSync(file.path);
    }
  } catch {
    // Ignore cleanup errors
  }
}

export function initLogger(grafemaDir: string): void {
  logsDir = join(grafemaDir, 'logs');
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  cleanupOldLogs();
  log(`[Grafema MCP] Logging initialized: ${logsDir}`);
}

export function getLogsDir(): string | null {
  return logsDir;
}

export function log(msg: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  try {
    appendFileSync(getLogFilePath(), line);
  } catch {
    // Fallback to /tmp if logs dir not initialized
    appendFileSync('/tmp/grafema-mcp.log', line);
  }
}

// === PAGINATION ===
export function guardResponseSize(text: string, maxSize: number = DEFAULT_RESPONSE_SIZE_LIMIT): string {
  if (text.length > maxSize) {
    const truncated = text.slice(0, maxSize);
    const remaining = text.length - maxSize;
    return truncated + `\n\n... [TRUNCATED: ${remaining.toLocaleString()} chars remaining. Use limit/offset for pagination]`;
  }
  return text;
}

export function normalizeLimit(limit: number | undefined | null): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

export function formatPaginationInfo(params: PaginationParams): string {
  const { limit: _limit, offset, returned, total, hasMore } = params;
  let info = `\n📄 Pagination: showing ${returned}`;
  if (total !== undefined) {
    info += ` of ${total}`;
  }
  if (offset > 0) {
    info += ` (offset: ${offset})`;
  }
  if (hasMore) {
    info += ` — use offset=${offset + returned} to get more`;
  }
  return info;
}

// === TYPE HELPERS ===
export function findSimilarTypes(
  queriedType: string,
  availableTypes: string[],
  maxDistance: number = 2
): string[] {
  const queriedLower = queriedType.toLowerCase();
  const similar: string[] = [];

  for (const type of availableTypes) {
    const dist = levenshtein(queriedLower, type.toLowerCase());
    if (dist <= maxDistance && (dist > 0 || queriedType !== type)) {
      similar.push(type);
    }
  }

  return similar;
}

export function extractQueriedTypes(query: string): { nodeTypes: string[]; edgeTypes: string[] } {
  const nodeTypes: string[] = [];
  const edgeTypes: string[] = [];

  // Match node(VAR, "TYPE") — the only working node predicate in the Rust evaluator.
  // Note: type(VAR, "TYPE") is intentionally excluded: the Rust evaluator has no "type"
  // branch and silently returns empty results. See separate issue for the root cause fix.
  const nodeRegex = /\bnode\([^,)]+,\s*"([^"]+)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRegex.exec(query)) !== null) {
    nodeTypes.push(m[1]);
  }

  // Match edge(SRC, DST, "TYPE") and incoming(DST, SRC, "TYPE")
  const edgeRegex = /\b(?:edge|incoming)\([^,)]+,\s*[^,)]+,\s*"([^"]+)"\)/g;
  while ((m = edgeRegex.exec(query)) !== null) {
    edgeTypes.push(m[1]);
  }

  return { nodeTypes, edgeTypes };
}

// Levenshtein distance implementation
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

// === SERIALIZATION ===
export function serializeBigInt(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(serializeBigInt);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = serializeBigInt(value);
    }
    return result;
  }
  return obj;
}

// === TOOL RESULT HELPERS ===
export function textResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function jsonResult(data: unknown, pretty: boolean = true): ToolResult {
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  return textResult(text);
}

// === PROCESS HELPERS ===
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// === FORMATTING ===
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}
