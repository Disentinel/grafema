# packages/gui-server — archived 2026-04-17

Superseded by rfdb-server's `ui` Cargo feature (REG-1100). rfdb-server now
serves `/ui/{db}` directly, embedding the GUI bundle via `rust-embed`.

Why archived:
- Duplicated HTTP serving logic already in `packages/rfdb-server/src/http_server.rs`
- VS Code extension (`packages/vscode/src/mapPanel.ts`) previously spawned
  this binary; now iframes `http://localhost:{port}/ui/{db}` served by rfdb.

Original purpose: a Rust binary (`grafema-gui`) that read RFDB via socket
and served hex topology HTML.

Restore path: `git mv _archive/packages-gui-server packages/gui-server`
and re-add to workspace.
