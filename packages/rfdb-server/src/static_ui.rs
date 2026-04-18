//! Static UI asset serving, feature-gated behind `ui`.
//!
//! The UI bundle is staged at build time by `build.rs` into
//! `$OUT_DIR/ui-dist/` — either the real Grafema GUI dist (when
//! `GRAFEMA_UI_DIST` is set) or a loud placeholder `index.html`. At compile
//! time `rust-embed` walks that directory and bakes every file into the
//! binary, so `rfdb-server` can serve the UI with no filesystem dependency
//! at runtime.
//!
//! # Public API (consumed by `http_server.rs` in C14c)
//!
//! - [`serve_spa_root`] — returns the SPA entry point (`web.html`, falling
//!   back to `index.html` / placeholder). Mount at `/ui/` and `/ui/{db}`.
//! - [`serve_asset`] — returns an embedded asset if the path matches,
//!   otherwise falls back to the SPA entry (so client-side routing works).
//!   Mount at `/ui/*path`.
//!
//! # Design notes
//!
//! - The GUI build produces three HTML entries (`index.html` for dev,
//!   `web.html` for the rfdb-served target, `vscode.html` for the webview
//!   extension). `rfdb-server` serves `web.html` as the root; `vscode.html`
//!   is still reachable via its exact path.
//! - Hashed assets under `assets/` get `Cache-Control: public, max-age=…,
//!   immutable`. Everything else (HTML, root-level icons, etc.) is
//!   `no-cache` to avoid pinning stale shells in CDNs or browsers.
//! - Paths are normalized by trimming a single leading `/` so the same
//!   function handles both `"/foo"` and `"foo"` (routers differ in how
//!   they pass wildcards).

use axum::{
    body::Body,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

/// Embedded UI assets, rooted at `$OUT_DIR/ui-dist/`.
///
/// Populated by `build.rs`:
///   * copied from `$GRAFEMA_UI_DIST` when set (typically
///     `packages/gui/dist`);
///   * otherwise a single-file placeholder (`index.html`) that surfaces a
///     build mis-configuration at runtime.
///
/// Exposed publicly so integration tests can enumerate which assets were
/// staged in a given build.
#[derive(RustEmbed)]
#[folder = "$OUT_DIR/ui-dist"]
pub struct UiAssets;

/// Serve the SPA root document (`web.html`).
///
/// Order of preference:
///   1. `web.html` — the rfdb-target bundle entry (produced by
///      `packages/gui`'s multi-target Vite build).
///   2. `index.html` — dev bundle or the build-time placeholder. Always
///      present thanks to the placeholder fallback in `build.rs`.
///
/// Returns 500 only if neither is embedded, which should be impossible
/// because `build.rs` always writes at least `index.html`.
pub fn serve_spa_root() -> Response {
    if let Some(content) = UiAssets::get("web.html") {
        return html_response(content.data.into_owned(), "no-cache");
    }
    if let Some(content) = UiAssets::get("index.html") {
        return html_response(content.data.into_owned(), "no-cache");
    }
    // build.rs guarantees at least a placeholder index.html, so reaching
    // here means the embed was never run with a valid OUT_DIR — a hard
    // misconfiguration worth surfacing as 500, not 404.
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "UI bundle missing — build.rs did not stage any HTML",
    )
        .into_response()
}

/// Serve an embedded asset by path, with SPA fallback.
///
/// Behavior:
///   * Exact match → return the file with derived MIME and cache headers.
///   * Miss → fall back to [`serve_spa_root`] so client-side routers like
///     React Router or TanStack Router see a 200 + HTML for unknown URLs.
///
/// The `path` argument may optionally start with a single `/` (routers
/// differ on whether wildcards strip it); both forms resolve identically.
pub fn serve_asset(path: &str) -> Response {
    let clean = path.trim_start_matches('/');

    // 1) Direct hit — embedded path matches request path exactly.
    if let Some(content) = UiAssets::get(clean) {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_for_path(clean))
            .header(header::CACHE_CONTROL, cache_control_for_path(clean))
            .body(Body::from(content.data.into_owned()))
            .unwrap();
    }

    // 2) Relative-base resolution — Vite builds with `base: './'` so HTML
    //    references `./assets/X.js`. If the SPA entry was served at
    //    `/ui/{db}/`, the browser resolves that to `/ui/{db}/assets/X.js`,
    //    which arrives here as `path = "{db}/assets/X.js"`. The embedded
    //    assets are rooted at `assets/`, so we strip any leading path
    //    segments up to and including the last `assets/` or `fixtures/`
    //    occurrence and retry. This keeps both no-trailing-slash
    //    (`/ui/default`) and trailing-slash (`/ui/default/`) URLs working.
    for prefix in ["assets/", "fixtures/"] {
        if let Some(pos) = clean.rfind(prefix) {
            let normalized = &clean[pos..];
            if normalized != clean {
                if let Some(content) = UiAssets::get(normalized) {
                    return Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, mime_for_path(normalized))
                        .header(header::CACHE_CONTROL, cache_control_for_path(normalized))
                        .body(Body::from(content.data.into_owned()))
                        .unwrap();
                }
            }
        }
    }

    // 3) SPA fallback — unknown paths return the shell so the client router
    //    can take over. This is the standard pattern for single-page apps
    //    hosted behind a wildcard route.
    serve_spa_root()
}

/// Build an `OK` HTML response with the given body and cache directive.
///
/// Extracted so `serve_spa_root` and any future HTML-returning helper stay
/// consistent on headers.
fn html_response(body: Vec<u8>, cache_control: &'static str) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, cache_control)
        .body(Body::from(body))
        .unwrap()
}

/// Map a file extension to a MIME type.
///
/// Kept deliberately small — only the handful of types the Grafema GUI
/// actually emits. Unknown extensions fall through to
/// `application/octet-stream`, which browsers treat as "download" and is
/// the safe default for anything we didn't explicitly vet.
///
/// Exposed publicly so integration tests can exercise the routing table
/// without round-tripping through the embed layer.
pub fn mime_for_path(path: &str) -> &'static str {
    // `rsplit('.').next()` yields the extension OR the whole string when no
    // dot is present — the `unwrap_or("")` path below treats both as
    // "unknown".
    let ext = path.rsplit('.').next().unwrap_or("");
    if ext == path {
        // No dot in the path at all — definitively unknown.
        return "application/octet-stream";
    }
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "map" => "application/json",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Choose a `Cache-Control` value based on where the asset lives.
///
/// Vite emits hashed filenames under `assets/` (e.g. `assets/web-<hash>.js`)
/// so those are safe to cache forever. Everything else — HTML, root-level
/// icons, robots.txt — must be `no-cache` to avoid pinning stale shells.
///
/// Exposed publicly for the same reason as [`mime_for_path`]: tests can
/// lock in the routing without spinning up real requests.
pub fn cache_control_for_path(path: &str) -> &'static str {
    let clean = path.trim_start_matches('/');
    if clean.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}
