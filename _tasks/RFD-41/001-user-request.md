# RFD-41: Unify RFDB version numbering (Cargo 0.1.0 vs npm 0.2.11)

## Source
Linear issue RFD-41, created 2026-02-17

## Problem

RFDB server has two independent version numbers that are never cross-validated:
- Rust `Cargo.toml`: `version = "0.1.0"` — returned by `env!("CARGO_PKG_VERSION")` in ping response
- npm `package.json`: `version = "0.2.11"` — used for npm publishing

These versions diverged and there's no validation between them.

## Desired outcome

- Single version number shared between Cargo.toml and package.json
- Build script or CI check that ensures they stay in sync
- `rfdb-server --version` matches npm package version

## Context

Discovered during RFD-40 exploration. Deferred from RFD-40 scope because fixing it requires deciding on a versioning strategy.

## Workflow

Mini-MLA (Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 4-Review → Vadim)
