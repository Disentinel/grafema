/**
 * Canonical JavaScript/TypeScript file extensions.
 *
 * SOURCE OF TRUTH — this list MUST mirror `is_js_ts_file` in the Rust
 * orchestrator (`packages/grafema-orchestrator/src/analyzer.rs`), which decides
 * which files are handed to the JS/TS analyzer and indexed as MODULE nodes:
 *
 * ```rust
 * matches!(ext, "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts")
 * ```
 *
 * Every TS-side list of "JS/TS extensions" (coverage classification, module
 * resolution candidate sets, re-export resolution, file-discovery globs) must
 * derive from this constant so the sets cannot silently drift apart. Hand-
 * maintained copies disagreeing with the orchestrator was the root cause of the
 * re-export under-resolution (#370, #372) and the coverage blind spot this
 * constant closes: `.mts`/`.cts` files were analyzed by the orchestrator but
 * omitted by downstream TS consumers, so they vanished from coverage and never
 * resolved as re-export targets.
 *
 * Extensions carry a leading dot. TS-family (`.ts/.tsx/.mts/.cts`) is listed
 * before JS-family (`.js/.jsx/.mjs/.cjs`) so consumers that pick the first
 * matching candidate prefer a TypeScript source over a compiled-JS sibling when
 * both are in the graph.
 *
 * @remarks Treat this primarily as a membership SET. Consumers that depend on a
 * particular probe order (e.g. {@link DEFAULT_EXTENSIONS} in module resolution)
 * keep their own order locally but are guarded by a drift test that asserts they
 * cover exactly this set.
 */
export const JS_TS_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

/**
 * The same extensions as a `Set` for O(1) membership checks (e.g. `extname(f)`
 * lookups during coverage classification and file scanning).
 */
export const JS_TS_EXTENSION_SET: ReadonlySet<string> = new Set(JS_TS_EXTENSIONS);
