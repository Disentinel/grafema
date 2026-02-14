# REG-382: @grafema/rfdb missing prebuilt binary for darwin-arm64

## Goal

Allow macOS arm64 users to run Grafema without manual Rust build.

## Acceptance Criteria

* `npm install @grafema/rfdb` provides a darwin-arm64 prebuilt binary.
* `npx @grafema/cli analyze --auto-start` works on macOS arm64 without extra steps.

## Context

On macOS arm64, `@grafema/rfdb` installs only `prebuilt/darwin-x64`, and `rfdb-server` fails to start. Had to install Rust and build `rfdb-server` manually, then set `GRAFEMA_RFDB_SERVER`.

This blocks onboarding for default macOS arm64 setups.
