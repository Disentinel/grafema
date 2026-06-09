/**
 * Pure (VS Code-independent) configuration generation for Grafema init.
 *
 * Extracted from initRunner.ts so the config-glob logic can be unit-tested
 * without the `vscode` module dependency. initRunner.ts re-exports these and
 * wires them into the workspace `runInit` flow.
 *
 * The JS/TS portion of SUPPORTED_EXTENSIONS MUST stay in sync with the
 * orchestrator's authoritative indexed set — `is_js_ts_file` in
 * packages/grafema-orchestrator/src/analyzer.rs (js | jsx | ts | tsx | mjs |
 * cjs | mts | cts). Any extension the orchestrator indexes but this list omits
 * is silently dropped from the generated `include` glob, so those files never
 * reach analysis even though the analyzer supports them.
 */

/** All file extensions supported by Grafema's analyzers. */
export const SUPPORTED_EXTENSIONS = [
  // JavaScript / TypeScript — mirrors analyzer.rs is_js_ts_file (drift-guard).
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  // Rust
  'rs',
  // Java / Kotlin
  'java', 'kt', 'kts',
  // Python
  'py', 'pyi',
  // Go
  'go',
  // Haskell
  'hs',
  // C / C++
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hxx', 'hh', 'inl', 'ipp', 'tpp', 'txx',
  // Swift / Objective-C
  'swift', 'm', 'mm',
  // BEAM (Elixir / Erlang)
  'ex', 'exs', 'erl', 'hrl',
];

/**
 * Generate `.grafema/config.yaml` content as a template string.
 *
 * No YAML library needed — fixed format. The `include` glob is derived from
 * {@link SUPPORTED_EXTENSIONS} so it covers exactly the analyzer-supported set.
 */
export function generateConfigYAML(): string {
  const extensions = SUPPORTED_EXTENSIONS.join(',');
  return `# Grafema Configuration
# Supported: JS/TS, Rust, Java, Kotlin, Python, Go, Haskell, C/C++, Swift, Elixir/Erlang

version: 1
root: ".."
include:
  - "**/*.{${extensions}}"
exclude:
  - "**/*.test.*"
  - "**/__tests__/**"
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/build/**"
  - "**/target/**"
  - "**/vendor/**"
  - "**/.git/**"

# services:  # Explicit service definitions (overrides auto-discovery)
#   - name: "api"
#     path: "."
#     entryPoint: "src/index.ts"
`;
}
