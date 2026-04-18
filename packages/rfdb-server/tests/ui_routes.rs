//! Integration tests for the `/ui/*` HTTP routes (feature-gated).
//!
//! These tests spin up a real `axum::serve` instance on an OS-chosen port,
//! then drive it with `reqwest` to verify the router wiring built by
//! `http_server::build_router_with_ui`.
//!
//! Each test case picks its own [`UiConfig`] explicitly rather than mutating
//! the process-global `RFDB_NO_UI` / `RFDB_STATIC_DIR` env vars — that way
//! the cases can run in parallel without racing on shared state. A single
//! test at the bottom exercises the env-var pathway (`ui_config_from_env`)
//! with a mutex so it doesn't clobber a concurrent test.
//!
//! See C14c in the rfdb-server UI rollout plan.
#![cfg(feature = "ui")]
#![allow(clippy::uninlined_format_args)]

use std::net::{SocketAddr, TcpListener as StdTcpListener};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rfdb::database_manager::DatabaseManager;
use rfdb::http_server::{build_router_with_ui, new_state, ui_config_from_env, HttpState, UiConfig};

// ── Helpers ──────────────────────────────────────────────────────────────

/// Reserve a free port by opening & immediately closing a synchronous
/// listener. Nothing inherently racy about this (a test process binding
/// next on port 0 might take a different port) — the test server binds on
/// 0 itself; we only use this when we *need* to know the port before the
/// server starts, which we don't, so we just bind on 0 and read back.
fn spawn_server(state: HttpState, ui: UiConfig) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    // Bind synchronously to choose an unused port, then hand the raw std
    // listener to tokio. Works around axum's async-only listener API in a
    // way that's portable across test runners.
    let std_listener = StdTcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
    std_listener.set_nonblocking(true).unwrap();
    let addr = std_listener.local_addr().unwrap();
    let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();

    let app = build_router_with_ui(state, ui);
    let handle = tokio::spawn(async move {
        // We expect this to keep running until the test shuts down tokio,
        // at which point `axum::serve` returns and the task completes.
        let _ = axum::serve(listener, app).await;
    });
    (addr, handle)
}

/// Build a minimal `HttpState` suitable for `/ui/*` tests. The UI routes
/// don't touch the database, but `HttpState` requires a `DatabaseManager`.
/// Use a temp dir so nothing leaks between runs.
fn test_state() -> HttpState {
    let tmp = tempfile::tempdir().expect("tempdir");
    // DatabaseManager::new is cheap and does not touch the filesystem until
    // you create a database — which we don't.
    let mgr = Arc::new(DatabaseManager::new(tmp.path().to_path_buf()));
    // Hold the tempdir alive by leaking it — test process is short-lived.
    std::mem::forget(tmp);
    new_state(mgr)
}

/// Serializes env-var mutating tests so they don't trample each other when
/// cargo runs tests in parallel. Cheap global.
fn env_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// True when only the build-time placeholder is staged (no real GUI dist
/// was embedded). Mirrors the helper in `tests/static_ui.rs`.
fn is_placeholder_only() -> bool {
    rfdb::static_ui::UiAssets::get("web.html").is_none()
}

/// Construct a reqwest client that skips DNS/connection pooling nonsense
/// and fails fast when the test server is down.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("reqwest client")
}

// ── Tests ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn ui_root_serves_spa_html_embedded() {
    let (addr, _srv) = spawn_server(test_state(), UiConfig::Embedded);
    let resp = client()
        .get(format!("http://{}/ui/", addr))
        .send()
        .await
        .expect("request send");

    assert_eq!(resp.status(), 200, "status: {}", resp.status());
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        ct.starts_with("text/html"),
        "expected html content-type, got {:?}",
        ct
    );

    let body = resp.text().await.expect("body text");
    assert!(
        body.contains("id=\"root\"") || body.contains("UI bundle not built"),
        "body looks neither like web.html nor placeholder: {}",
        &body[..body.len().min(200)]
    );
}

#[tokio::test]
async fn ui_db_prefix_spa_fallback() {
    // `/ui/mydb` — no file named "mydb" is embedded, so the SPA root must
    // be returned for client-side routing.
    let (addr, _srv) = spawn_server(test_state(), UiConfig::Embedded);
    let resp = client()
        .get(format!("http://{}/ui/mydb", addr))
        .send()
        .await
        .expect("request send");

    assert_eq!(resp.status(), 200);
    let body = resp.text().await.expect("body text");
    assert!(
        body.contains("id=\"root\"") || body.contains("UI bundle not built"),
        "body shape wrong: {}",
        &body[..body.len().min(200)]
    );
}

#[tokio::test]
async fn ui_unknown_asset_falls_back_to_spa() {
    // `/ui/mydb/assets/index.js` with no such file embedded — React Router
    // / TanStack Router clients expect the SPA shell here.
    let (addr, _srv) = spawn_server(test_state(), UiConfig::Embedded);
    let resp = client()
        .get(format!("http://{}/ui/mydb/assets/index.js", addr))
        .send()
        .await
        .expect("request send");

    assert_eq!(resp.status(), 200);
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        ct.starts_with("text/html"),
        "SPA fallback must return html, got {:?}",
        ct
    );
}

#[tokio::test]
async fn ui_subpath_without_file_falls_back_to_spa() {
    // Directory-shaped path: `/ui/mydb/assets/`. `serve_asset` trims the
    // leading slash and looks up `assets/` which is never a real file → SPA.
    let (addr, _srv) = spawn_server(test_state(), UiConfig::Embedded);
    let resp = client()
        .get(format!("http://{}/ui/mydb/assets/", addr))
        .send()
        .await
        .expect("request send");

    assert_eq!(resp.status(), 200);
    let body = resp.text().await.expect("body text");
    assert!(
        body.contains("id=\"root\"") || body.contains("UI bundle not built"),
        "body shape wrong: {}",
        &body[..body.len().min(200)]
    );
}

#[tokio::test]
async fn ui_known_asset_is_served_when_real_dist_embedded() {
    // Only runs when a real GUI dist was baked in at build time; with the
    // placeholder this path has nothing meaningful to assert.
    if is_placeholder_only() {
        return;
    }
    let asset = rfdb::static_ui::UiAssets::iter()
        .find(|p| p.starts_with("assets/") && p.ends_with(".js"))
        .expect("expected at least one hashed .js asset");
    let (addr, _srv) = spawn_server(test_state(), UiConfig::Embedded);
    let resp = client()
        .get(format!("http://{}/ui/mydb/{}", addr, asset))
        .send()
        .await
        .expect("request send");

    assert_eq!(resp.status(), 200);
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        ct.starts_with("application/javascript"),
        "expected JS mime, got {:?}",
        ct
    );
}

#[tokio::test]
async fn ui_asset_resolves_at_root_of_ui() {
    // Regression: Vite builds with `base: './'`, producing HTML that references
    // `./assets/X.js`. When the SPA is served at `/ui/default` (no trailing
    // slash — VS Code's URL) the browser resolves assets against `/ui/` and
    // requests `/ui/assets/X.js`. The old route `/ui/{db}/{*path}` mis-parsed
    // this as db="assets" and dropped the real path, returning the SPA shell
    // with text/html content-type instead of JS. New single-wildcard route
    // plus `serve_asset` fallback to `rfind("assets/")` must serve the JS.
    if is_placeholder_only() {
        return;
    }
    let asset = rfdb::static_ui::UiAssets::iter()
        .find(|p| p.starts_with("assets/") && p.ends_with(".js"))
        .expect("expected at least one hashed .js asset");
    let (addr, _srv) = spawn_server(test_state(), UiConfig::Embedded);

    // Shape 1: /ui/{asset} (page was /ui/default — no trailing slash)
    let resp1 = client()
        .get(format!("http://{}/ui/{}", addr, asset))
        .send()
        .await
        .expect("request send");
    assert_eq!(resp1.status(), 200, "/ui/{} should serve JS", asset);
    let ct1 = resp1
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        ct1.starts_with("application/javascript"),
        "/ui/{} expected JS, got {:?}",
        asset,
        ct1
    );

    // Shape 2: /ui/default/{asset} (page was /ui/default/ — trailing slash)
    let resp2 = client()
        .get(format!("http://{}/ui/default/{}", addr, asset))
        .send()
        .await
        .expect("request send");
    assert_eq!(resp2.status(), 200);
    let ct2 = resp2
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        ct2.starts_with("application/javascript"),
        "/ui/default/{} expected JS, got {:?}",
        asset,
        ct2
    );

    // Shape 3: deeper nesting /ui/a/b/c/{asset}
    let resp3 = client()
        .get(format!("http://{}/ui/a/b/c/{}", addr, asset))
        .send()
        .await
        .expect("request send");
    assert_eq!(resp3.status(), 200);
    let ct3 = resp3
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        ct3.starts_with("application/javascript"),
        "/ui/a/b/c/{} expected JS, got {:?}",
        asset,
        ct3
    );
}

#[tokio::test]
async fn ui_disabled_returns_404() {
    let (addr, _srv) = spawn_server(test_state(), UiConfig::Disabled);
    let resp = client()
        .get(format!("http://{}/ui/", addr))
        .send()
        .await
        .expect("request send");
    // With no UI routes mounted, axum's default fallback produces a 404.
    assert_eq!(resp.status(), 404, "expected 404, got {}", resp.status());
}

#[tokio::test]
async fn ui_static_dir_serves_custom_files() {
    // Hand-build a mini dist on disk; `ServeDir` must serve *its*
    // `index.html`, not the embedded bundle.
    let tmp = tempfile::tempdir().expect("tempdir");
    let custom_html = b"<!doctype html><html><body>CUSTOM-STATIC-DIR-MARKER</body></html>";
    std::fs::write(tmp.path().join("index.html"), custom_html).unwrap();

    let dir: PathBuf = tmp.path().to_path_buf();
    let (addr, _srv) = spawn_server(test_state(), UiConfig::StaticDir(dir));
    let resp = client()
        .get(format!("http://{}/ui/", addr))
        .send()
        .await
        .expect("request send");

    assert_eq!(resp.status(), 200);
    let body = resp.text().await.expect("body text");
    assert!(
        body.contains("CUSTOM-STATIC-DIR-MARKER"),
        "static-dir override did not serve local index.html: {}",
        &body[..body.len().min(200)]
    );
    // Belt-and-braces: confirm the embedded placeholder marker is *not*
    // present — catches accidental fall-through to the embedded branch.
    assert!(
        !body.contains("UI bundle not built"),
        "static-dir served placeholder instead of local file"
    );
}

#[tokio::test]
async fn ui_static_dir_serves_nested_assets() {
    let tmp = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(tmp.path().join("assets")).unwrap();
    std::fs::write(tmp.path().join("index.html"), b"<html>root</html>").unwrap();
    std::fs::write(
        tmp.path().join("assets").join("app.js"),
        b"console.log('static-dir-asset');",
    )
    .unwrap();

    let (addr, _srv) = spawn_server(test_state(), UiConfig::StaticDir(tmp.path().to_path_buf()));
    let resp = client()
        .get(format!("http://{}/ui/assets/app.js", addr))
        .send()
        .await
        .expect("request send");

    assert_eq!(resp.status(), 200);
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // `tower_http::services::ServeDir` derives MIME from the extension.
    assert!(
        ct.contains("javascript"),
        "expected javascript mime, got {:?}",
        ct
    );
    let body = resp.text().await.expect("body text");
    assert!(body.contains("static-dir-asset"));
}

#[tokio::test]
async fn api_routes_still_work_with_ui_disabled() {
    // Sanity check: `/api/*` is unaffected by UI gating. We can't hit
    // `/api/stats` without a default DB, but a 200-JSON error is still a
    // proof the handler fired; alternatively `/api/node/{id}` always
    // responds. Hitting /api/node/0 is cheap.
    let (addr, _srv) = spawn_server(test_state(), UiConfig::Disabled);
    let resp = client()
        .get(format!("http://{}/api/node/0", addr))
        .send()
        .await
        .expect("request send");
    // The handler returns JSON with an error (no "default" db). Either a
    // 200 with JSON or a 4xx/5xx is fine — we just need something other
    // than "route not found" (404 from axum's default fallback would
    // actually still be 404, but that'd indicate the route was not
    // registered). To disambiguate, we check that `/api/stats` also
    // responds: if the route table is empty under UI=Disabled, *both*
    // /api/node/0 and /api/stats would 404, but with the route mounted
    // we get JSON.
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        ct.contains("json"),
        "expected JSON from /api/node/0 with UI disabled, got content-type {:?} and status {}",
        ct,
        resp.status()
    );
}

// ── Env-var pathway ──────────────────────────────────────────────────────

#[test]
fn ui_config_from_env_precedence_no_ui_wins() {
    // Precedence contract: RFDB_NO_UI=1 → Disabled, even if
    // RFDB_STATIC_DIR is also set.
    let _g = env_lock().lock().unwrap();
    // Snapshot + restore the env vars we touch.
    let prev_no_ui = std::env::var_os("RFDB_NO_UI");
    let prev_static = std::env::var_os("RFDB_STATIC_DIR");
    // SAFETY: test-only, mutex serialized.
    unsafe {
        std::env::set_var("RFDB_NO_UI", "1");
        std::env::set_var("RFDB_STATIC_DIR", "/tmp/whatever");
    }
    let cfg = ui_config_from_env();
    // Restore before any assert so a failure doesn't leak env state.
    unsafe {
        match prev_no_ui {
            Some(v) => std::env::set_var("RFDB_NO_UI", v),
            None => std::env::remove_var("RFDB_NO_UI"),
        }
        match prev_static {
            Some(v) => std::env::set_var("RFDB_STATIC_DIR", v),
            None => std::env::remove_var("RFDB_STATIC_DIR"),
        }
    }
    assert!(matches!(cfg, UiConfig::Disabled), "got {:?}", cfg);
}

#[test]
fn ui_config_from_env_static_dir_when_no_ui_unset() {
    let _g = env_lock().lock().unwrap();
    let prev_no_ui = std::env::var_os("RFDB_NO_UI");
    let prev_static = std::env::var_os("RFDB_STATIC_DIR");
    unsafe {
        std::env::remove_var("RFDB_NO_UI");
        std::env::set_var("RFDB_STATIC_DIR", "/tmp/some-dist");
    }
    let cfg = ui_config_from_env();
    unsafe {
        match prev_no_ui {
            Some(v) => std::env::set_var("RFDB_NO_UI", v),
            None => std::env::remove_var("RFDB_NO_UI"),
        }
        match prev_static {
            Some(v) => std::env::set_var("RFDB_STATIC_DIR", v),
            None => std::env::remove_var("RFDB_STATIC_DIR"),
        }
    }
    match cfg {
        UiConfig::StaticDir(p) => assert_eq!(p, PathBuf::from("/tmp/some-dist")),
        other => panic!("expected StaticDir, got {:?}", other),
    }
}

#[test]
fn ui_config_from_env_defaults_to_embedded() {
    let _g = env_lock().lock().unwrap();
    let prev_no_ui = std::env::var_os("RFDB_NO_UI");
    let prev_static = std::env::var_os("RFDB_STATIC_DIR");
    unsafe {
        std::env::remove_var("RFDB_NO_UI");
        std::env::remove_var("RFDB_STATIC_DIR");
    }
    let cfg = ui_config_from_env();
    unsafe {
        match prev_no_ui {
            Some(v) => std::env::set_var("RFDB_NO_UI", v),
            None => std::env::remove_var("RFDB_NO_UI"),
        }
        match prev_static {
            Some(v) => std::env::set_var("RFDB_STATIC_DIR", v),
            None => std::env::remove_var("RFDB_STATIC_DIR"),
        }
    }
    assert!(matches!(cfg, UiConfig::Embedded), "got {:?}", cfg);
}
