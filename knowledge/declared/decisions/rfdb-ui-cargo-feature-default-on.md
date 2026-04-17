---
id: kb:decision:rfdb-ui-cargo-feature-default-on
type: DECISION
status: active
effective_from: 2026-04-17
projections:
  - epistemic
created: 2026-04-17
---

## rfdb-server embeds GUI bundle via Cargo feature `ui` (default on, optional rust-embed)

### Decision
`packages/rfdb-server/Cargo.toml`:
```toml
[features]
default = ["ui"]
ui = ["dep:rust-embed", "tower-http/fs"]
```

`build.rs` reads `$GRAFEMA_UI_DIST` and stages files into `$OUT_DIR/ui-dist/` for `rust-embed`. Missing env var → loud placeholder `index.html` + cargo warnings. Routes `/ui/`, `/ui/{db}`, `/ui/{db}/{*path}` gated by feature. CLI `--static-dir <path>` overrides embedded bundle (dev); `--no-ui` kills route at runtime.

### Rejected alternatives
- **Always-on embed (no feature gate):** headless deployments (API-only, no browser) still ship ~1 MB UI bundle. User confirmed "делаем сборку без гуя" → feature gate with default on.
- **Serve from filesystem only (`--static-dir` mandatory):** requires users to know paths; end-user friction. `rust-embed` makes binary self-contained for production.
- **`rust-embed`'s `$OUT_DIR` without `interpolate-folder-path` feature:** silent fail at derive-macro time with "folder does not exist". Feature flag required (caught in C14b).

### Consequences
- Two build paths: `scripts/build-gui-for-rfdb.sh` for default (UI-embedded); `cargo build -p rfdb-server --no-default-features` for headless.
- Precedence at runtime: `--no-ui` > `--static-dir` > embedded. Tested in `ui_routes.rs`.
- Three tests per build-path: `compile_without_ui` (gate), `static_ui` (RustEmbed + MIME), `ui_routes` (E2E via real axum server).
