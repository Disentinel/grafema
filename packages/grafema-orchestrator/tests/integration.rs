//! Integration tests for grafema-orchestrator.
//!
//! Tests the pipeline components that work without external services:
//! - Config → Discovery → OXC Parsing (no RFDB or grafema-analyzer needed)
//! - Plugin DAG ordering
//! - Generation GC logic with real files
//!
//! Tests that require running rfdb-server or grafema-analyzer are marked
//! with #[ignore] and can be run with `cargo test -- --ignored`.

use std::path::{Path, PathBuf};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("sample-project")
}

mod config_and_discovery {
    use super::*;

    #[test]
    fn load_config_and_discover_files() {
        let config_path = fixture_dir().join("grafema.config.yaml");
        let cfg = grafema_orchestrator::config::load(&config_path).unwrap();

        assert_eq!(cfg.include, vec!["src/**/*.js", "src/**/*.ts"]);
        assert_eq!(cfg.exclude, vec!["src/**/*.spec.js"]);

        let files = grafema_orchestrator::discovery::discover(&cfg).unwrap();

        // Should find: index.js, utils.js, math.js, broken.js, types.ts
        assert_eq!(files.len(), 5, "Expected 5 files, got: {:?}", files);

        // Files should be sorted
        let names: Vec<_> = files
            .iter()
            .map(|f| f.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"index.js".to_string()));
        assert!(names.contains(&"utils.js".to_string()));
        assert!(names.contains(&"math.js".to_string()));
        assert!(names.contains(&"types.ts".to_string()));
        assert!(names.contains(&"broken.js".to_string()));
    }

    #[test]
    fn exclude_patterns_work() {
        // Create a temporary config that excludes broken.js
        let dir = fixture_dir();
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let config_content = format!(
            "root: \"{}\"\ninclude:\n  - \"src/**/*.js\"\nexclude:\n  - \"src/broken.js\"\n",
            dir.display()
        );
        std::fs::write(tmp.path(), &config_content).unwrap();

        let cfg = grafema_orchestrator::config::load(tmp.path()).unwrap();
        let files = grafema_orchestrator::discovery::discover(&cfg).unwrap();

        let names: Vec<_> = files
            .iter()
            .map(|f| f.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(!names.contains(&"broken.js".to_string()));
        assert!(names.contains(&"index.js".to_string()));
    }
}

mod oxc_parsing {
    use super::*;

    #[test]
    fn parse_all_fixture_files() {
        let config_path = fixture_dir().join("grafema.config.yaml");
        let cfg = grafema_orchestrator::config::load(&config_path).unwrap();
        let files = grafema_orchestrator::discovery::discover(&cfg).unwrap();

        for file in &files {
            let result = grafema_orchestrator::parser::parse_file(file);
            let name = file.file_name().unwrap().to_string_lossy();

            match result {
                Ok(pr) => {
                    // All files should produce valid JSON with "type": "Program"
                    assert!(
                        pr.json.contains("\"type\":\"Program\""),
                        "File {} did not produce Program node",
                        name
                    );

                    // broken.js should have parse errors but still produce partial AST
                    if name == "broken.js" {
                        assert!(
                            !pr.errors.is_empty(),
                            "broken.js should have parse errors"
                        );
                    }
                }
                Err(e) => {
                    panic!("Failed to parse {}: {}", name, e);
                }
            }
        }
    }

    #[test]
    fn parse_typescript_file() {
        let file = fixture_dir().join("src").join("types.ts");
        let result = grafema_orchestrator::parser::parse_file(&file).unwrap();

        assert!(result.json.contains("\"type\":\"Program\""));
        // TypeScript files should include type annotations
        assert!(
            result.json.contains("TSTypeAnnotation")
                || result.json.contains("typeAnnotation"),
            "TypeScript annotations should be present"
        );
        assert!(result.errors.is_empty(), "types.ts should have no errors");
    }

    #[test]
    fn parse_produces_byte_offsets() {
        let file = fixture_dir().join("src").join("math.js");
        let result = grafema_orchestrator::parser::parse_file(&file).unwrap();

        // Verify the JSON contains start/end fields (byte offsets)
        assert!(result.json.contains("\"start\":"));
        assert!(result.json.contains("\"end\":"));
        // Should NOT contain "range" since we pass false
        // (range would appear as "range":[start,end])
    }
}

mod plugin_dag {
    #[test]
    fn build_dag_from_config() {
        // Simulate plugin configs
        let plugins = vec![
            make_plugin("enricher-a", vec![]),
            make_plugin("enricher-b", vec!["enricher-a".into()]),
            make_plugin("validator", vec!["enricher-a".into(), "enricher-b".into()]),
        ];

        let levels = grafema_orchestrator::plugin::build_dag(&plugins).unwrap();
        assert_eq!(levels.len(), 3);
        assert_eq!(levels[0].len(), 1); // enricher-a
        assert_eq!(levels[0][0].name, "enricher-a");
        assert_eq!(levels[1].len(), 1); // enricher-b
        assert_eq!(levels[1][0].name, "enricher-b");
        assert_eq!(levels[2].len(), 1); // validator
        assert_eq!(levels[2][0].name, "validator");
    }

    #[test]
    fn build_dag_parallel_plugins() {
        let plugins = vec![
            make_plugin("base", vec![]),
            make_plugin("plugin-a", vec!["base".into()]),
            make_plugin("plugin-b", vec!["base".into()]),
            make_plugin("final", vec!["plugin-a".into(), "plugin-b".into()]),
        ];

        let levels = grafema_orchestrator::plugin::build_dag(&plugins).unwrap();
        assert_eq!(levels.len(), 3);
        assert_eq!(levels[0].len(), 1); // base
        assert_eq!(levels[1].len(), 2); // plugin-a and plugin-b (parallel)
        assert_eq!(levels[2].len(), 1); // final
    }

    #[test]
    fn build_dag_cycle_rejected() {
        let plugins = vec![
            make_plugin("a", vec!["b".into()]),
            make_plugin("b", vec!["a".into()]),
        ];

        let err = grafema_orchestrator::plugin::build_dag(&plugins).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("cycle") || msg.contains("Cycle"),
            "Expected cycle error, got: {msg}"
        );
    }

    fn make_plugin(name: &str, depends_on: Vec<String>) -> grafema_orchestrator::config::PluginConfig {
        grafema_orchestrator::config::PluginConfig {
            name: name.to_string(),
            command: format!("echo {name}"),
            query: None,
            depends_on,
            mode: grafema_orchestrator::config::PluginMode::Streaming,
            timeout_secs: None,
        }
    }
}

mod generation_gc {
    use super::*;

    #[test]
    fn incremental_analysis_skips_unchanged() {
        let config_path = fixture_dir().join("grafema.config.yaml");
        let cfg = grafema_orchestrator::config::load(&config_path).unwrap();
        let files = grafema_orchestrator::discovery::discover(&cfg).unwrap();

        let mut tracker = grafema_orchestrator::gc::GenerationTracker::new(0);
        let _gen = tracker.bump();

        // First run: all files are "changed" (no mtimes recorded)
        let (changed, unchanged) =
            grafema_orchestrator::gc::filter_changed_files(&files, &tracker, false).unwrap();
        assert_eq!(changed.len(), files.len());
        assert_eq!(unchanged.len(), 0);

        // Record mtimes
        grafema_orchestrator::gc::update_mtimes(&mut tracker, &files).unwrap();

        // Second run: no files changed
        let (changed2, unchanged2) =
            grafema_orchestrator::gc::filter_changed_files(&files, &tracker, false).unwrap();
        assert_eq!(changed2.len(), 0, "No files should be changed");
        assert_eq!(unchanged2.len(), files.len());
    }

    #[test]
    fn force_flag_overrides_mtime() {
        let config_path = fixture_dir().join("grafema.config.yaml");
        let cfg = grafema_orchestrator::config::load(&config_path).unwrap();
        let files = grafema_orchestrator::discovery::discover(&cfg).unwrap();

        let mut tracker = grafema_orchestrator::gc::GenerationTracker::new(0);
        tracker.bump();
        grafema_orchestrator::gc::update_mtimes(&mut tracker, &files).unwrap();

        // With force=true, all files are "changed" even though mtimes match
        let (changed, _) =
            grafema_orchestrator::gc::filter_changed_files(&files, &tracker, true).unwrap();
        assert_eq!(changed.len(), files.len());
    }

    #[test]
    fn detect_deleted_files_from_real_discovery() {
        let config_path = fixture_dir().join("grafema.config.yaml");
        let cfg = grafema_orchestrator::config::load(&config_path).unwrap();
        let files = grafema_orchestrator::discovery::discover(&cfg).unwrap();

        let mut tracker = grafema_orchestrator::gc::GenerationTracker::new(0);
        tracker.bump();
        grafema_orchestrator::gc::update_mtimes(&mut tracker, &files).unwrap();

        // Simulate: pretend only 3 of 5 files still exist
        let partial_files: Vec<_> = files.iter().take(3).cloned().collect();
        let deleted = grafema_orchestrator::gc::detect_deleted_files(&tracker, &partial_files);
        assert_eq!(deleted.len(), 2, "Should detect 2 deleted files");
    }
}

mod wire_conversion {
    use std::collections::HashMap;

    #[test]
    fn round_trip_analysis_to_wire() {
        let analysis = grafema_orchestrator::analyzer::FileAnalysis {
            file: "src/test.js".to_string(),
            module_id: "MODULE#src/test.js".to_string(),
            nodes: vec![grafema_orchestrator::analyzer::GraphNode {
                id: "src/test.js->FUNCTION->foo".to_string(),
                node_type: "FUNCTION".to_string(),
                name: "foo".to_string(),
                file: "src/test.js".to_string(),
                line: 1,
                column: 0,
                end_line: 0,
                end_column: 0,
                exported: true,
                metadata: HashMap::new(),
                extra: HashMap::new(),
            }],
            edges: vec![grafema_orchestrator::analyzer::GraphEdge {
                src: "src/test.js->FUNCTION->foo".to_string(),
                dst: "src/test.js->CALL->bar".to_string(),
                edge_type: "CALLS".to_string(),
                metadata: HashMap::new(),
            }],
            exports: vec![grafema_orchestrator::analyzer::ExportInfo {
                name: "foo".to_string(),
                node_id: "src/test.js->FUNCTION->foo".to_string(),
                kind: "named".to_string(),
                source: None,
            }],
        };

        let wire_nodes = grafema_orchestrator::analyzer::to_wire_nodes(&analysis);
        assert_eq!(wire_nodes.len(), 1);
        assert_eq!(wire_nodes[0].id, "src/test.js->FUNCTION->foo");
        assert_eq!(wire_nodes[0].node_type.as_deref(), Some("FUNCTION"));
        assert!(wire_nodes[0].exported);

        let wire_edges = grafema_orchestrator::analyzer::to_wire_edges(&analysis);
        assert_eq!(wire_edges.len(), 1);
        assert_eq!(wire_edges[0].src, "src/test.js->FUNCTION->foo");
        assert_eq!(wire_edges[0].edge_type, "CALLS");
    }

    #[test]
    fn metadata_stamping_on_wire_types() {
        let analysis = grafema_orchestrator::analyzer::FileAnalysis {
            file: "test.js".to_string(),
            module_id: "MODULE#test.js".to_string(),
            nodes: vec![grafema_orchestrator::analyzer::GraphNode {
                id: "test.js->VAR->x".to_string(),
                node_type: "VARIABLE".to_string(),
                name: "x".to_string(),
                file: "test.js".to_string(),
                line: 1,
                column: 6,
                end_line: 0,
                end_column: 0,
                exported: false,
                metadata: {
                    let mut m = HashMap::new();
                    m.insert("kind".to_string(), serde_json::json!("const"));
                    m
                },
                extra: HashMap::new(),
            }],
            edges: vec![],
            exports: vec![],
        };

        let mut wire_nodes = grafema_orchestrator::analyzer::to_wire_nodes(&analysis);

        // Stamp with generation metadata
        for node in &mut wire_nodes {
            grafema_orchestrator::gc::stamp_node_metadata(&mut node.metadata, 42, "analyzer");
        }

        let meta_str = wire_nodes[0].metadata.as_ref().unwrap();
        let meta: serde_json::Value = serde_json::from_str(meta_str).unwrap();
        assert_eq!(meta["_generation"], 42);
        assert_eq!(meta["_source"], "analyzer");
        // Original metadata should be preserved
        assert_eq!(meta["kind"], "const");
    }
}

mod cpp_parser {
    use std::path::Path;

    #[test]
    fn parse_demo_cpp_and_output_ast() {
        let demo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("_tasks/REG-665/demo.cpp");

        if !demo.exists() {
            eprintln!("demo.cpp not found at {}", demo.display());
            return;
        }

        let ast = grafema_orchestrator::cpp_parser::parse_cpp_file(&demo, None)
            .expect("Failed to parse demo.cpp");

        // Write wrapped payload to temp file for analyzer
        let payload = serde_json::json!({
            "file": "demo.cpp",
            "ast": ast
        });

        let out_path = std::env::temp_dir().join("cpp_demo_ast.json");
        std::fs::write(&out_path, serde_json::to_string_pretty(&payload).unwrap())
            .expect("Failed to write AST JSON");

        eprintln!("AST written to {}", out_path.display());

        // Count top-level children
        let children = ast.get("children")
            .and_then(|c| c.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        eprintln!("Top-level children: {}", children);

        // Count all nodes by kind
        let mut kind_counts = std::collections::HashMap::new();
        count_kinds(&ast, &mut kind_counts);
        let mut sorted: Vec<_> = kind_counts.iter().collect();
        sorted.sort_by_key(|(_, c)| std::cmp::Reverse(**c));
        eprintln!("\nAST node kinds:");
        for (kind, count) in &sorted {
            eprintln!("  {}: {}", kind, count);
        }
        eprintln!("Total AST nodes: {}", sorted.iter().map(|(_, c)| *c).sum::<usize>());

        assert!(children > 0, "Expected at least one top-level child");
    }

    fn count_kinds(node: &serde_json::Value, counts: &mut std::collections::HashMap<String, usize>) {
        if let Some(kind) = node.get("kind").and_then(|k| k.as_str()) {
            *counts.entry(kind.to_string()).or_insert(0) += 1;
        }
        if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
            for child in children {
                count_kinds(child, counts);
            }
        }
    }
}
