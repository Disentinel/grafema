import { appendFileSync } from 'fs';

/**
 * Append one event to the analysis JSONL profiler (`.grafema/analysis-profile.jsonl`),
 * matching the schema the Rust orchestrator writes: `ts`, `elapsed_ms`, `event`,
 * `rss_mb`, `cpu_s`, plus arbitrary custom fields.
 *
 * Why this exists: the orchestrator stops profiling at `analysis_complete_final`,
 * but the CLI runs the TS enrichers (mcp-tool, contract, behavior, package-api…)
 * AFTER the orchestrator process exits. Without this append, that ~90s enrich tail
 * is a blind spot in the JSONL profiler and the route view. `startTimeMs` is the
 * analyze-invocation start (Date.now()), so enrich events sort after every
 * orchestrator event when the profile is read back as a timeline.
 *
 * Best-effort: never throws — profiling must not fail an analyze run.
 */
export function appendProfileEvent(
  profilePath: string,
  startTimeMs: number,
  event: string,
  fields: Record<string, string | number> = {},
): void {
  try {
    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    const cpuS = process.cpuUsage().user / 1e6;
    const rec: Record<string, unknown> = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      elapsed_ms: Date.now() - startTimeMs,
      event,
      rss_mb: Math.round(rssMb * 10) / 10,
      cpu_s: Math.round(cpuS * 100) / 100,
      ...fields,
    };
    appendFileSync(profilePath, JSON.stringify(rec) + '\n');
  } catch {
    // Profiling is best-effort; swallow all errors.
  }
}
