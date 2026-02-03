# Grafema VS Code Extension - Build and Install from Source

Install Grafema Explore VS Code extension from monorepo source.

## When to Use

- After making changes to `packages/vscode/` code
- Setting up development environment for VS Code extension
- Installing extension without npm package (pre-release)

## Prerequisites

- Node.js 20+
- pnpm (or npm)
- Rust toolchain (for rfdb-server binary)

## Build and Install Steps

### 1. Build all monorepo packages

```bash
cd /Users/vadimr/grafema
pnpm build
```

This builds:
- `packages/types` - TypeScript types
- `packages/rfdb` - RFDB client
- `packages/rfdb-server` - Rust binary (cargo build --release)
- `packages/core` - Core analysis engine
- `packages/vscode` - VS Code extension

### 2. Package the extension

```bash
cd packages/vscode
npx vsce package --no-dependencies
```

Creates `grafema-explore-0.0.1.vsix`

### 3. Install in VS Code

```bash
code --install-extension grafema-explore-0.0.1.vsix --force
```

### 4. Clean up

```bash
rm grafema-explore-0.0.1.vsix
```

### 5. Restart VS Code

The extension activates when you open the "Grafema Explore" panel in Explorer sidebar.

## One-liner (after initial build)

```bash
cd /Users/vadimr/grafema/packages/vscode && \
node esbuild.config.mjs && \
npx vsce package --no-dependencies && \
code --install-extension grafema-explore-0.0.1.vsix --force && \
rm grafema-explore-0.0.1.vsix
```

## Troubleshooting

### "RFDB server binary not found"

The extension needs `rfdb-server` binary. It looks in:
1. `GRAFEMA_RFDB_SERVER` environment variable
2. Monorepo paths relative to extension
3. `/Users/vadimr/grafema/packages/rfdb-server/target/release/rfdb-server`
4. `@grafema/rfdb` npm package

For development, ensure you ran `pnpm build` which builds the Rust binary.

### "pnpm: command not found" in install script

Use npm directly or ensure pnpm is in PATH:
```bash
npm install -g pnpm
# or use corepack
corepack enable
```

### Extension doesn't appear

1. Check VS Code Developer Tools (Help > Toggle Developer Tools) for errors
2. Ensure `.grafema/graph.rfdb` exists in workspace (run `grafema analyze` first)
3. Restart VS Code after installation

## Alternative: Use install script

```bash
cd /Users/vadimr/grafema/packages/vscode
./scripts/install-local.sh
```

Note: Script requires `pnpm` in PATH.
