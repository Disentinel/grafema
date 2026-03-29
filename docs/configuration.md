# Grafema Configuration Reference

> **Most projects work with zero configuration** — just run `grafema init` and go. The Rust orchestrator has a built-in analysis pipeline that handles JS/TS out of the box.

## Quick Start

```bash
grafema init
```

Creates `.grafema/config.yaml` with sensible defaults.

## Configuration File

Grafema looks for configuration in `.grafema/config.yaml`.

```
your-project/
├── .grafema/
│   ├── config.yaml       # Configuration (version controlled)
│   ├── guarantees.yaml   # Invariants (version controlled)
│   └── graph.rfdb        # Graph database (gitignored)
├── src/
└── ...
```

## Minimal Configuration

For most projects, `grafema init` generates all you need:

```yaml
# .grafema/config.yaml
version: "0.3"
root: ".."
include:
  - "src/**/*.{ts,tsx,js,jsx}"
exclude:
  - "**/*.test.*"
  - "**/__tests__/**"
  - "**/node_modules/**"
  - "**/dist/**"
```

## Configuration Options

### version

Schema version string. Generated automatically by `grafema init`.

### root

Path to the project root, relative to the `.grafema/` directory. Usually `".."` since config lives in `.grafema/config.yaml`.

### include

Glob patterns for files to analyze. Only files matching at least one pattern are processed.

```yaml
include:
  - "src/**/*.{ts,tsx,js,jsx}"
  - "lib/**/*.js"
```

### exclude

Glob patterns for files to skip. Takes precedence over `include`.

```yaml
exclude:
  - "**/*.test.*"
  - "**/__mocks__/**"
  - "**/fixtures/**"
  - "**/node_modules/**"
  - "**/dist/**"
```

`node_modules` is always excluded automatically.

### services

Explicit service definitions for multi-service projects (monorepos). When specified, auto-discovery is skipped.

```yaml
services:
  - name: "api"
    path: "packages/api"
    entryPoint: "src/server.ts"
  - name: "web"
    path: "packages/web"
    entryPoint: "src/index.tsx"
```

- `name` — Service identifier (used in graph node IDs)
- `path` — Service directory relative to project root
- `entryPoint` — Optional entry file (auto-detected if omitted)

If `services` is not specified, Grafema uses auto-discovery via `package.json`.

## Configuration Examples

### TypeScript project

```yaml
version: "0.3"
root: ".."
include:
  - "src/**/*.{ts,tsx,js,jsx}"
exclude:
  - "**/*.test.*"
  - "**/__tests__/**"
  - "**/node_modules/**"
  - "**/dist/**"
```

### JavaScript project

```yaml
version: "0.3"
root: ".."
include:
  - "src/**/*.{js,jsx,mjs,cjs}"
exclude:
  - "**/*.test.*"
  - "**/__tests__/**"
  - "**/node_modules/**"
  - "**/dist/**"
```

### Monorepo with multiple services

```yaml
version: "0.3"
root: ".."
include:
  - "packages/*/src/**/*.{ts,tsx,js,jsx}"
exclude:
  - "**/*.test.*"
  - "**/node_modules/**"
  - "**/dist/**"
services:
  - name: "api"
    path: "packages/api"
    entryPoint: "src/server.ts"
  - name: "web"
    path: "packages/web"
    entryPoint: "src/index.tsx"
  - name: "shared"
    path: "packages/shared"
    entryPoint: "src/index.ts"
```

### Large codebase (selective analysis)

```yaml
version: "0.3"
root: ".."
include:
  - "src/api/**/*.ts"
  - "src/core/**/*.ts"
exclude:
  - "**/*.test.*"
  - "**/__tests__/**"
  - "**/*.generated.*"
  - "**/node_modules/**"
  - "**/dist/**"
```

## Overriding with `--force`

To regenerate config from scratch:

```bash
grafema init --force
```

## See Also

- [Getting Started](getting-started.md) - First-time setup
- [Known Limitations](../KNOWN_LIMITATIONS.md) - What works and what doesn't
