---
id: kb:fact:rust-embed-interpolate-folder-path-required
type: FACT
confidence: high
subtype: error
projections:
  - epistemic
created: 2026-04-17
---

## rust-embed `#[folder = "$OUT_DIR/..."]` needs the `interpolate-folder-path` feature

### Fact
```rust
#[derive(RustEmbed)]
#[folder = "$OUT_DIR/ui-dist"]
struct UiAssets;
```

Without `rust-embed = { version = "8", features = ["interpolate-folder-path"], optional = true }`, the derive macro silently does NOT expand `$OUT_DIR`. Compilation fails with a misleading message like "folder `$OUT_DIR/ui-dist` does not exist" (it's trying to find a literal filesystem path).

Hit in Phase 7b (C14b). Fix: add the feature to the optional dep.

### Consequence
Documentation doesn't emphasise this — `rust-embed`'s README examples use literal paths. For build.rs + env-var-staged dist trees (common in Rust+JS hybrid builds), the feature is mandatory. Worth a skill for future Rust+SPA projects.
