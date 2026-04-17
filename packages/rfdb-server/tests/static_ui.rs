//! Integration tests for the `static_ui` module (feature-gated).
//!
//! These tests rely on the embedded asset tree produced by `build.rs` at
//! `$OUT_DIR/ui-dist/`. When `GRAFEMA_UI_DIST` is set at build time, the tree
//! contains the real GUI dist (including `web.html` and hashed JS/CSS under
//! `assets/`). Otherwise only a placeholder `index.html` is present.
//!
//! The assertions below accept both shapes so the tests work in either
//! configuration.
#![cfg(feature = "ui")]
#![allow(clippy::uninlined_format_args)]
#![allow(clippy::bool_assert_comparison)]
#![allow(clippy::needless_borrow)]
#![allow(unused_parens)]

// `RustEmbed`'s derive generates inherent methods on `UiAssets`, so importing
// the struct alone is enough — the `RustEmbed` trait re-import is not needed.
use rfdb::static_ui::{self, UiAssets};

/// Synchronously read a full `Response<Body>` body into bytes.
/// Wraps `axum::body::to_bytes` with a scoped tokio runtime.
fn body_to_string(resp: axum::response::Response) -> String {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let body = resp.into_body();
    let bytes = rt
        .block_on(axum::body::to_bytes(body, usize::MAX))
        .expect("body read");
    String::from_utf8(bytes.to_vec()).expect("utf-8 body")
}

/// True when only the build-time placeholder is staged (i.e. no real GUI dist
/// was copied in). We detect this by the placeholder-only marker file set:
/// `index.html` exists but neither `web.html` nor any `assets/*` entry does.
fn is_placeholder_only() -> bool {
    // `UiAssets::get` is the canonical API so we don't duplicate the folder
    // literal here. Fall back to "yes, placeholder" if `web.html` is absent.
    UiAssets::get("web.html").is_none()
}

#[test]
fn spa_root_returns_html_with_correct_content_type() {
    let resp = static_ui::serve_spa_root();
    assert_eq!(resp.status(), 200);

    let content_type = resp
        .headers()
        .get("content-type")
        .expect("content-type header present")
        .to_str()
        .unwrap();
    assert!(
        content_type.starts_with("text/html"),
        "unexpected content-type: {}",
        content_type
    );

    let body = body_to_string(resp);
    // Either the real SPA (has a #root container) or the placeholder.
    assert!(
        body.contains("id=\"root\"") || body.contains("UI bundle not built"),
        "body doesn't look like web.html or placeholder: {}",
        &body[..body.len().min(200)]
    );
}

#[test]
fn spa_root_prefers_web_html_when_available() {
    if is_placeholder_only() {
        // With only the placeholder staged there is no `web.html`; the
        // fallback to `index.html` is the documented behavior. Skip the
        // "prefers web.html" assertion in that case.
        return;
    }
    let resp = static_ui::serve_spa_root();
    let body = body_to_string(resp);
    // `web.html` uses `lang="en"` and title "Grafema Map" — stable across
    // GUI builds (see packages/gui/web.html template).
    assert!(
        body.contains("Grafema Map") || body.contains("web-"),
        "web.html content signature missing: {}",
        &body[..body.len().min(400)]
    );
}

#[test]
fn asset_known_path_returns_content_with_mime() {
    if is_placeholder_only() {
        // No hashed assets staged — nothing to fetch. The other tests still
        // cover the unknown-path + fallback branches with the placeholder.
        return;
    }

    // Enumerate to pick any concrete asset (e.g. `assets/web-DD_VfnO0.js`).
    // The filename hash changes per build, so we search rather than hardcode.
    let asset_path = UiAssets::iter()
        .find(|p| p.starts_with("assets/") && p.ends_with(".js"))
        .expect("expected at least one hashed .js asset in real GUI dist")
        .into_owned();

    let resp = static_ui::serve_asset(&asset_path);
    assert_eq!(resp.status(), 200);

    let content_type = resp
        .headers()
        .get("content-type")
        .expect("content-type header present")
        .to_str()
        .unwrap();
    assert!(
        content_type.starts_with("application/javascript"),
        "expected JS mime, got {}",
        content_type
    );

    let cache_control = resp
        .headers()
        .get("cache-control")
        .expect("cache-control header present")
        .to_str()
        .unwrap();
    assert!(
        cache_control.contains("immutable"),
        "assets/ should be immutable-cached, got {}",
        cache_control
    );
}

#[test]
fn asset_unknown_path_spa_fallback() {
    // `/some/client-side/route` has no matching asset — must fall back to the
    // SPA root (web.html, or placeholder when only that is staged). This is
    // the behavior that enables client-side routing.
    let resp = static_ui::serve_asset("some/client-side/route");
    assert_eq!(resp.status(), 200);

    let content_type = resp
        .headers()
        .get("content-type")
        .expect("content-type header present")
        .to_str()
        .unwrap();
    assert!(
        content_type.starts_with("text/html"),
        "fallback should return html, got {}",
        content_type
    );

    let body = body_to_string(resp);
    assert!(
        body.contains("id=\"root\"") || body.contains("UI bundle not built"),
        "fallback body doesn't look like SPA root: {}",
        &body[..body.len().min(200)]
    );
}

#[test]
fn asset_leading_slash_is_tolerated() {
    // Both `/foo` and `foo` must resolve the same way — a fallback in this
    // case because `/foo` is not a real asset path.
    let resp_slash = static_ui::serve_asset("/some/route");
    let resp_no_slash = static_ui::serve_asset("some/route");
    assert_eq!(resp_slash.status(), resp_no_slash.status());
}

#[test]
fn mime_for_extensions_covers_web_basics() {
    // Exercise the public surface: call `serve_asset` on virtual paths that
    // only hit `mime_for`. Since the asset lookup misses, each returns the
    // SPA fallback — but to test mime routing we embed a parallel check via
    // a separate small helper exposed as `mime_for_path` (see static_ui.rs).
    use static_ui::mime_for_path;
    assert_eq!(mime_for_path("foo.html"), "text/html; charset=utf-8");
    assert_eq!(mime_for_path("foo.js"), "application/javascript; charset=utf-8");
    assert_eq!(mime_for_path("foo.mjs"), "application/javascript; charset=utf-8");
    assert_eq!(mime_for_path("foo.css"), "text/css; charset=utf-8");
    assert_eq!(mime_for_path("foo.json"), "application/json");
    assert_eq!(mime_for_path("foo.svg"), "image/svg+xml");
    assert_eq!(mime_for_path("foo.png"), "image/png");
    assert_eq!(mime_for_path("foo.jpg"), "image/jpeg");
    assert_eq!(mime_for_path("foo.jpeg"), "image/jpeg");
    assert_eq!(mime_for_path("foo.gif"), "image/gif");
    assert_eq!(mime_for_path("foo.webp"), "image/webp");
    assert_eq!(mime_for_path("foo.woff2"), "font/woff2");
    assert_eq!(mime_for_path("foo.woff"), "font/woff");
    assert_eq!(mime_for_path("foo.ttf"), "font/ttf");
    assert_eq!(mime_for_path("foo.ico"), "image/x-icon");
    assert_eq!(mime_for_path("foo.map"), "application/json");
    assert_eq!(mime_for_path("foo.unknown-ext"), "application/octet-stream");
    assert_eq!(mime_for_path("noext"), "application/octet-stream");
}

#[test]
fn cache_control_hashed_vs_root() {
    // `assets/*` must be immutable-cached (hashed filenames), everything else
    // must be no-cache to avoid serving stale HTML. The easiest way to
    // observe this without round-tripping through UiAssets is to check the
    // helper directly.
    use static_ui::cache_control_for_path;
    assert_eq!(
        cache_control_for_path("assets/foo-abc123.js"),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(cache_control_for_path("web.html"), "no-cache");
    assert_eq!(cache_control_for_path("favicon.ico"), "no-cache");
}
