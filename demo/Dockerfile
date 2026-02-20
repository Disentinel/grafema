# Grafema Docker Demo
#
# Multi-stage build: Rust stage compiles rfdb-server, builder stage compiles
# JS/TS and generates graph, runtime stage is a lean code-server image.
#
# Usage:
#   docker build -t grafema-demo -f demo/Dockerfile .
#   docker run -p 8080:8080 grafema-demo
#   open http://localhost:8080

# ==============================================================================
# Stage 0: Rust builder — compile rfdb-server with WebSocket support
# ==============================================================================
FROM rust:1-bookworm AS rust-builder

WORKDIR /rfdb
COPY packages/rfdb-server/Cargo.toml packages/rfdb-server/Cargo.lock ./
COPY packages/rfdb-server/src/ src/
COPY packages/rfdb-server/benches/ benches/
RUN cargo build --release --bin rfdb-server

# ==============================================================================
# Stage 1: Builder — install deps, build packages, generate graph, package vsix
# ==============================================================================
FROM node:22-bookworm AS builder

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Install vsce globally for extension packaging
RUN npm install -g @vscode/vsce

WORKDIR /build

# Copy dependency manifests first (layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/api/package.json packages/api/
COPY packages/mcp/package.json packages/mcp/
COPY packages/vscode/package.json packages/vscode/
COPY packages/rfdb/package.json packages/rfdb/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy full source
COPY . .

# Build all JS/TS packages (skip @grafema/rfdb which needs Cargo — we use prebuilt binary)
RUN pnpm -r --filter '!@grafema/rfdb' build

# Package VS Code extension (.vsix) — universal build for code-server
RUN cd packages/vscode && vsce package --no-dependencies

# Run self-analysis: grafema analyze on the Grafema source itself
# This creates .grafema/graph.rfdb with the full code graph
# Use rfdb-server compiled from source (with WebSocket support)
# NOTE: No --clear flag — clear() makes V2 engine ephemeral (in-memory only).
# Fresh build has no existing DB, so --clear is unnecessary anyway.
COPY --from=rust-builder /rfdb/target/release/rfdb-server /usr/local/bin/rfdb-server
ENV GRAFEMA_RFDB_SERVER=/usr/local/bin/rfdb-server
RUN node packages/cli/dist/cli.js analyze /build --auto-start

# Prepare a clean source tree for the demo workspace (no node_modules, dist)
RUN mkdir -p /demo-source && \
    cp package.json pnpm-workspace.yaml tsconfig.json /demo-source/ && \
    cp -r .grafema /demo-source/.grafema && \
    for pkg in packages/*/; do \
        mkdir -p "/demo-source/$pkg"; \
        cp "$pkg/package.json" "/demo-source/$pkg" 2>/dev/null || true; \
        [ -d "$pkg/src" ] && cp -r "$pkg/src" "/demo-source/$pkg/src"; \
    done

# ==============================================================================
# Stage 2: Runtime — code-server with Grafema extension + rfdb-server
# ==============================================================================
FROM codercom/code-server:latest

USER root

# Install supervisord and netcat for health checks
RUN apt-get update && \
    apt-get install -y --no-install-recommends supervisor netcat-openbsd && \
    rm -rf /var/lib/apt/lists/*

# Copy rfdb-server binary (compiled from source with WebSocket support)
COPY --from=rust-builder /rfdb/target/release/rfdb-server /usr/local/bin/rfdb-server
RUN chmod +x /usr/local/bin/rfdb-server

# Copy .vsix from builder
COPY --from=builder /build/packages/vscode/*.vsix /tmp/grafema-explore.vsix

# Copy clean source tree + pre-built graph from builder
COPY --from=builder /demo-source/ /home/coder/workspace/grafema/

# Create VS Code settings for websocket transport
RUN mkdir -p /home/coder/workspace/grafema/.vscode && \
    printf '{\n  "grafema.rfdbTransport": "websocket",\n  "grafema.rfdbWebSocketUrl": "ws://localhost:7432"\n}\n' \
    > /home/coder/workspace/grafema/.vscode/settings.json

# Copy configuration files
COPY demo/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY demo/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Fix ownership so coder user can read everything
RUN chown -R coder:coder /home/coder/workspace

# Expose code-server port
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
