/**
 * RFDB RPC client timeout configuration.
 *
 * The RFDB client guards every request with a timeout so a hung/unresponsive
 * server (or an invalid dbPath) surfaces as a rejected promise instead of an
 * indefinite hang. The original ceiling was a single hardcoded 60s.
 *
 * That 60s is fine for *interactive* round-trips (getNode, neighbors, ping),
 * but it is too tight for two classes of operation on a large graph:
 *
 *   1. Bulk writes — `addEdges` / `addNodes` / `commitBatch` over the
 *      self-analyze (~714k nodes) make the server do index work that can
 *      legitimately exceed 60s. The JS enrichers (enrichMcpToolDefinitions,
 *      contract, behavior, package) all write through `addEdges`, so a 60s
 *      ceiling makes the enrichers silently fail with
 *      `RFDB addEdges timed out after 60000ms`.
 *   2. Streaming reads — `queryNodesStream` waits for the *first* chunk; on a
 *      714k-node graph the initial scan can take longer than 60s before the
 *      first chunk arrives (`queryNodesStream timed out after 60000ms`).
 *   3. Durable drops — `clear` / `dropDatabase` durably truncate a large
 *      on-disk .rfdb, which can exceed 60s.
 *
 * Resolution: timeouts are now env-configurable and tiered per operation. We
 * keep a *finite* ceiling everywhere (never Infinity) so a genuinely wedged
 * server still fails loudly — we just give slow-but-progressing bulk/drop work
 * enough room.
 *
 * Env vars (all in milliseconds, all optional):
 *   RFDB_RPC_TIMEOUT_MS       — default ceiling for interactive ops.
 *                               Default 300_000 (5 min).
 *   RFDB_RPC_BULK_TIMEOUT_MS  — ceiling for bulk writes & streaming first-chunk
 *                               & durable drops. Default = 3× the interactive
 *                               ceiling, i.e. 900_000 (15 min) by default.
 *
 * Why 5 min default (was 60s): a full self-analyze is ~14 min wall and the
 * slow individual RPCs we observed (bulk addEdges, first stream chunk) sit in
 * the tens-of-seconds-to-low-minutes range on the 714k graph. 5 min gives a
 * comfortable margin for interactive ops on a large graph while still failing
 * a truly hung server in bounded time. Bulk/drop gets 15 min because a durable
 * drop / large commit is the single longest legitimate operation.
 */

function readEnvMs(name: string): number | undefined {
  const raw =
    typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/** Default ceiling for interactive ops (env: RFDB_RPC_TIMEOUT_MS). */
export function getDefaultTimeoutMs(): number {
  return readEnvMs('RFDB_RPC_TIMEOUT_MS') ?? 300_000;
}

/**
 * Ceiling for bulk writes / streaming first-chunk / durable drops
 * (env: RFDB_RPC_BULK_TIMEOUT_MS). Defaults to 3× the interactive ceiling.
 */
export function getBulkTimeoutMs(): number {
  const explicit = readEnvMs('RFDB_RPC_BULK_TIMEOUT_MS');
  if (explicit !== undefined) return explicit;
  return getDefaultTimeoutMs() * 3;
}

/**
 * Commands that operate on the whole graph / disk and deserve the longer
 * bulk ceiling rather than the interactive default.
 */
const BULK_COMMANDS: ReadonlySet<string> = new Set([
  'addEdges',
  'addNodes',
  'commitBatch',
  'clear',
  'dropDatabase',
  'compact',
  'flush',
  'rebuildIndexes',
  'getAllNodes',
  'getAllEdges',
  'getEdgesByType',
]);

/**
 * Resolve the timeout ceiling for a given command, honoring an explicit
 * per-call override when the caller passed one.
 */
export function resolveTimeoutMs(
  cmd: string,
  explicitTimeoutMs?: number,
): number {
  if (explicitTimeoutMs !== undefined) return explicitTimeoutMs;
  return BULK_COMMANDS.has(cmd) ? getBulkTimeoutMs() : getDefaultTimeoutMs();
}
