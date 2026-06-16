# Grafema MCP server — stdio image
#
# This image runs the Grafema MCP server (`grafema-mcp`) over stdio, the
# transport used by MCP clients (Claude Desktop, Cursor, Glama, etc.) and by
# Glama's automated introspection check (MCP `initialize` + `tools/list`).
#
# The analyzed project is bind-mounted at /workspace at runtime, e.g.:
#   docker run -i --rm -v "$PWD":/workspace grafema-mcp
# For Glama's static introspection an empty /workspace is fine — the tool
# list (~40 tools) is static and does not require an analyzed project.
#
# Note: `npm install -g grafema` pulls the native analyzer / rfdb binaries
# (~100MB+), so the image is intentionally on the larger side.

FROM node:22-bookworm-slim

# ca-certificates is needed for TLS (npm install + any outbound calls the
# native binaries make). The native binaries are dynamically linked against
# glibc, already present in the -bookworm-slim (Debian) base.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the Grafema CLI + MCP server globally. This provides the
# `grafema-mcp` binary (from the `grafema` package, dist/mcp-server.js).
RUN npm install -g grafema@latest \
    && npm cache clean --force

# The analyzed project is bind-mounted here at runtime.
WORKDIR /workspace

# Start the MCP server over stdio against the mounted project.
ENTRYPOINT ["grafema-mcp", "--project", "/workspace"]
