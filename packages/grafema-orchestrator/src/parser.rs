//! OXC parsing: JS/TS files -> ESTree JSON for grafema-analyzer.
//!
//! Uses the OXC Rust crate to parse JavaScript and TypeScript files into
//! ESTree-compatible JSON. The output contains `start` and `end` byte offsets
//! on every node, matching what the Haskell analyzer expects.

use anyhow::Result;
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use rayon::prelude::*;
use std::path::{Path, PathBuf};

/// Result of parsing a single file.
pub struct ParseResult {
    /// ESTree JSON representation of the AST.
    pub json: String,
    /// Parse errors reported by OXC. May be non-empty even when a partial AST
    /// is produced — the caller decides what to do (e.g. emit ISSUE nodes).
    pub errors: Vec<String>,
}

/// Parse source text to ESTree JSON using OXC.
///
/// Uses the TypeScript-aware serializer (`to_estree_ts_json`) which includes
/// TypeScript-specific fields for .ts/.tsx files and simply omits them for
/// plain .js/.jsx. Byte offsets are used (not UTF-16), matching the Haskell
/// analyzer's expectations.
///
/// The `ranges` parameter is set to `false` — only `start`/`end` fields are
/// emitted, not the `range` array.
pub fn parse_to_estree(source: &str, filename: &Path) -> Result<String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(filename)
        .map_err(|e| anyhow::anyhow!("Unknown file type for {}: {e}", filename.display()))?;

    let ret = Parser::new(&allocator, source, source_type).parse();

    // OXC produces a partial AST even when there are errors.
    // Serialize it — the caller can inspect errors separately via `parse_file`.
    let json = ret.program.to_estree_ts_json(false);
    Ok(json)
}

/// Read a file from disk and parse it to ESTree JSON.
///
/// Returns a `ParseResult` containing the JSON and any parse errors.
/// If the file cannot be read, returns an `Err`. If the file can be read
/// but has syntax errors, the partial AST JSON is still returned alongside
/// the error messages.
pub fn parse_file(path: &Path) -> Result<ParseResult> {
    let source = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("Failed to read {}: {e}", path.display()))?;

    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path)
        .map_err(|e| anyhow::anyhow!("Unknown file type for {}: {e}", path.display()))?;

    let ret = Parser::new(&allocator, &source, source_type).parse();

    let errors: Vec<String> = ret.errors.iter().map(|e| e.to_string()).collect();
    let json = ret.program.to_estree_ts_json(false);

    Ok(ParseResult { json, errors })
}

/// Parse multiple files in parallel using rayon.
///
/// Returns a vector of `(path, result)` pairs preserving the input order.
/// Each result is independent — a failure in one file does not affect others.
///
/// `jobs` controls the rayon thread pool size. If 0, rayon's default
/// (number of logical CPUs) is used.
pub fn parse_files_parallel(
    files: &[PathBuf],
    jobs: usize,
) -> Vec<(PathBuf, Result<ParseResult>)> {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(if jobs == 0 { 0 } else { jobs })
        .build()
        .expect("Failed to build rayon thread pool");

    pool.install(|| {
        files
            .par_iter()
            .map(|path| {
                let result = parse_file(path);
                (path.clone(), result)
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_simple_const_declaration() {
        let source = "const x = 1;";
        let filename = Path::new("test.js");
        let json = parse_to_estree(source, filename).expect("parse should succeed");

        assert!(
            json.contains("\"type\":\"Program\""),
            "JSON should contain Program node, got: {json}"
        );
        assert!(
            json.contains("\"type\":\"VariableDeclaration\""),
            "JSON should contain VariableDeclaration node, got: {json}"
        );
    }


    #[test]
    fn parse_typescript_source() {
        let source = "const x: number = 42;";
        let filename = Path::new("test.ts");
        let json = parse_to_estree(source, filename).expect("parse should succeed");

        assert!(json.contains("\"type\":\"Program\""));
        assert!(json.contains("\"type\":\"VariableDeclaration\""));
        // TS-specific: type annotation should be present
        assert!(
            json.contains("\"typeAnnotation\""),
            "JSON should contain typeAnnotation for TS, got: {json}"
        );
    }

    #[test]
    fn parse_has_start_end_offsets() {
        let source = "let a = 1;";
        let filename = Path::new("test.js");
        let json = parse_to_estree(source, filename).expect("parse should succeed");

        assert!(
            json.contains("\"start\""),
            "JSON should contain start offsets"
        );
        assert!(
            json.contains("\"end\""),
            "JSON should contain end offsets"
        );
        // When ranges=false, the range array should NOT be present
        assert!(
            !json.contains("\"range\""),
            "JSON should NOT contain range array when ranges=false"
        );
    }

    #[test]
    fn parse_unknown_extension_fails() {
        let source = "hello world";
        let filename = Path::new("test.txt");
        let result = parse_to_estree(source, filename);
        assert!(result.is_err(), "Parsing .txt should fail");
    }

    #[test]
    fn parse_file_with_errors_returns_partial_ast() {
        let source = "const x = ;"; // syntax error
        let filename = Path::new("test.js");
        // Even with a syntax error, OXC produces a partial AST
        let json = parse_to_estree(source, filename).expect("should still return JSON");
        assert!(json.contains("\"type\":\"Program\""));
    }

    #[test]
    fn parse_file_reports_errors() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("grafema-parser-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("bad.js");
        {
            let mut f = std::fs::File::create(&file_path).unwrap();
            f.write_all(b"const x = ;").unwrap();
        }

        let result = parse_file(&file_path).expect("parse_file should succeed for readable file");
        assert!(
            !result.errors.is_empty(),
            "Should report syntax errors"
        );
        assert!(result.json.contains("\"type\":\"Program\""));

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }
}
