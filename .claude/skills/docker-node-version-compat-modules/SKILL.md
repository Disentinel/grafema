---
name: docker-node-version-compat-modules
description: |
  Fix Node.js CLI tools crashing inside Docker containers when host-installed node_modules
  require a newer Node version than the container provides. Use when: (1) "SyntaxError: Invalid
  regular expression flags" with /v flag in string-width or similar packages, (2) node_modules
  installed on host with Node 20+ but container has Node 18, (3) `npm install` with file:
  protocol creates symlinks that break inside Docker, (4) pnpm workspace packages become
  broken symlinks in containers. Covers version detection, Node binary mounting, and
  npm install strategies for cross-version compatibility.
author: Claude Code
version: 1.0.0
date: 2026-02-10
---

# Docker Node Version Compatibility for Mounted node_modules

## Problem

When mounting host-installed `node_modules` into a Docker container, packages may require
a newer Node.js version than what's available in the container. This causes cryptic runtime
errors (not install-time errors) because npm doesn't enforce `engines` constraints by default.

## Context / Trigger Conditions

- **Primary symptom**: `SyntaxError: Invalid regular expression flags` on the `/v` flag
  (Unicode Sets, requires Node 20+)
- **Affected packages**: `string-width@8.x`, `ink@6.x`, and their dependents
- **Scenario**: Host has Node 20+, Docker container has Node 18 (common in SWE-bench images)
- **Also triggers when**: `npm install` with `file:` protocol creates symlinks to host paths
  that don't exist inside the container
- **Also triggers when**: pnpm workspace `@scope/pkg` entries are symlinks to
  `../../../../workspace/packages/pkg` — broken inside Docker

## Root Cause

1. **npm doesn't enforce `engines` by default**: Even with `--engine-strict`, it only checks
   direct dependencies, not transitive ones. Packages like `string-width@8.x` declare
   `"engines": {"node": ">=20"}` but npm happily installs them on any Node version.

2. **`file:` protocol creates symlinks**: `npm install file:../path` creates a symlink in
   `node_modules/` pointing to the host path. Inside Docker, that host path doesn't exist.

3. **pnpm workspace symlinks**: In pnpm monorepos, `node_modules/@scope/pkg` is a symlink
   to `../../packages/pkg`. These are relative to the workspace root, not the mount point.

## Diagnostic Steps

**CRITICAL: Before attempting any fix, verify these first:**

1. Check Node version in the target container:
   ```bash
   docker run --rm <image> node --version
   ```

2. Check if the tool actually worked before (don't assume — **read the trajectory/logs**):
   ```bash
   # Look for actual command outputs, not just references in prompts
   grep '"returncode": 0' trajectory.json | grep grafema
   ```

3. Check for symlinks in mounted node_modules:
   ```bash
   docker exec <container> bash -c "ls -la /opt/node_modules/@scope/"
   ```

## Solutions

### Solution A: Mount Node 20+ Binary (Recommended)

Download a Node.js binary for Linux and mount it alongside node_modules:

```bash
# Download once
curl -sL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz | \
  tar -xJ -C /path/to/node20 --strip-components=1

# Mount and use in container
docker run -v /path/to/node20:/opt/node20:ro \
           -v /path/to/node_modules:/opt/modules:ro \
           <image> bash -c "
  export PATH=/opt/node20/bin:\$PATH
  # Create wrapper script for the CLI tool
  echo '#!/bin/bash' > /usr/local/bin/mytool
  echo 'exec /opt/node20/bin/node /opt/modules/.bin/mytool \"\$@\"' >> /usr/local/bin/mytool
  chmod +x /usr/local/bin/mytool
"
```

### Solution B: Install with Version Constraints

Install inside a container matching the target Node version with overrides:

```bash
docker run --rm -v /path/to/install:/install node:18 bash -c '
  cd /install
  npm install --engine-strict  # Will fail if deps need Node 20+
'
```

If this fails (because core deps like ink require Node 20+), Solution A is the only option.

### Solution C: pnpm pack + npm install (Flat Layout)

For pnpm monorepos, create tarballs first to eliminate workspace symlinks:

```bash
# On host (resolves workspace:* protocol)
pnpm -C packages/cli pack --pack-destination /tmp/packs

# Install from tarballs (creates real directories, not symlinks)
# Do this inside a Docker container matching target Node version
docker run --rm -v /tmp/packs:/packs:ro -v /path/to/install:/install node:20 bash -c '
  cd /install
  cat > package.json << EOF
  {"dependencies": {"@scope/cli": "file:/packs/cli-1.0.0.tgz"}}
  EOF
  npm install
'
```

**Important**: Use `pnpm pack` (not `npm pack`) to resolve `workspace:*` protocol.

## Anti-Patterns

1. **Don't dereference symlinks with `cp -RL`**: This copies files but npm still resolves
   the latest dependency versions, which may require newer Node.

2. **Don't use `pnpm deploy` for Docker mounts**: It creates `.pnpm/` layout with internal
   symlinks that cause ESM resolution errors in some Node versions.

3. **Don't debug Docker setup without checking if it ever worked**: Verify in actual
   trajectory outputs, not by counting keyword references in prompts/logs.

4. **Don't try multiple fixes in sequence without diagnosing**: Check Node version
   compatibility FIRST before attempting any fix.

## Verification

```bash
# Test the full command, not just the binary path
docker exec <container> bash -c "export PATH=/opt/node20/bin:\$PATH; mytool --version"

# Test a command that exercises dependency loading (not just the entry point)
docker exec <container> bash -c "export PATH=/opt/node20/bin:\$PATH; mytool impact 'someFunction'"
```

## Notes

- SWE-bench Docker images use different Node versions: axios=Node 20, preact=Node 18
- `grafema overview` may work while `grafema impact` fails because they load different modules
- The `/v` regex flag (Unicode Sets) is the most common Node 20 breakage point
- `ink` (terminal UI framework) switched to Node 20+ requirement starting from v6.0.0
