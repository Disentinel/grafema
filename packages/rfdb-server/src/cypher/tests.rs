//! Tests for the Cypher query engine.

use super::*;

mod parser_tests {
    use super::*;

    #[test]
    fn simple_node_scan() {
        let q = parse_cypher("MATCH (n:FUNCTION) RETURN n.name").unwrap();
        assert_eq!(q.match_clause.pattern.start.variable, Some("n".to_string()));
        assert_eq!(q.match_clause.pattern.start.labels, vec!["FUNCTION".to_string()]);
        assert!(q.match_clause.pattern.segments.is_empty());
        assert!(q.where_clause.is_none());
        assert_eq!(q.return_clause.items.len(), 1);
        assert_eq!(
            q.return_clause.items[0].expr,
            Expr::Property("n".to_string(), "name".to_string())
        );
        assert!(q.return_clause.items[0].alias.is_none());
    }

    #[test]
    fn node_with_inline_properties() {
        let q = parse_cypher("MATCH (n:FUNCTION {name: 'main'}) RETURN n").unwrap();
        let node = &q.match_clause.pattern.start;
        assert_eq!(node.variable, Some("n".to_string()));
        assert_eq!(node.labels, vec!["FUNCTION".to_string()]);
        assert_eq!(node.properties.len(), 1);
        assert_eq!(node.properties[0].0, "name");
        assert_eq!(
            node.properties[0].1,
            Expr::Literal(CypherLiteral::Str("main".to_string()))
        );
        assert_eq!(q.return_clause.items[0].expr, Expr::Variable("n".to_string()));
    }

    #[test]
    fn relationship_outgoing() {
        let q =
            parse_cypher("MATCH (a:FUNCTION)-[:CALLS]->(b) RETURN a.name, b.name").unwrap();
        let chain = &q.match_clause.pattern;
        assert_eq!(chain.start.variable, Some("a".to_string()));
        assert_eq!(chain.segments.len(), 1);

        let (rel, node) = &chain.segments[0];
        assert_eq!(rel.direction, Direction::Outgoing);
        assert_eq!(rel.rel_types, vec!["CALLS".to_string()]);
        assert!(rel.variable.is_none());
        assert_eq!(node.variable, Some("b".to_string()));

        assert_eq!(q.return_clause.items.len(), 2);
    }

    #[test]
    fn relationship_incoming() {
        let q =
            parse_cypher("MATCH (a)<-[:CALLS]-(b) RETURN b.name").unwrap();
        let (rel, node) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.direction, Direction::Incoming);
        assert_eq!(rel.rel_types, vec!["CALLS".to_string()]);
        assert_eq!(node.variable, Some("b".to_string()));
    }

    #[test]
    fn relationship_bidirectional() {
        let q = parse_cypher("MATCH (a)-[:CALLS]-(b) RETURN a.name").unwrap();
        let (rel, _) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.direction, Direction::Both);
        assert_eq!(rel.rel_types, vec!["CALLS".to_string()]);
    }

    #[test]
    fn variable_length_path() {
        let q =
            parse_cypher("MATCH (a)-[:CALLS*1..5]->(b) RETURN b.name").unwrap();
        let (rel, _) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.direction, Direction::Outgoing);
        assert_eq!(rel.length, Some((1, 5)));
    }

    #[test]
    fn where_with_and_or() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.name = 'main' AND n.file CONTAINS 'src' RETURN n",
        )
        .unwrap();

        match &q.where_clause {
            Some(Expr::And(left, right)) => {
                match left.as_ref() {
                    Expr::BinaryOp(l, BinOp::Eq, r) => {
                        assert_eq!(**l, Expr::Property("n".to_string(), "name".to_string()));
                        assert_eq!(
                            **r,
                            Expr::Literal(CypherLiteral::Str("main".to_string()))
                        );
                    }
                    other => panic!("expected BinaryOp, got {:?}", other),
                }
                match right.as_ref() {
                    Expr::Contains(l, r) => {
                        assert_eq!(**l, Expr::Property("n".to_string(), "file".to_string()));
                        assert_eq!(
                            **r,
                            Expr::Literal(CypherLiteral::Str("src".to_string()))
                        );
                    }
                    other => panic!("expected Contains, got {:?}", other),
                }
            }
            other => panic!("expected And, got {:?}", other),
        }
    }

    #[test]
    fn where_with_not() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE NOT n.exported RETURN n.name",
        )
        .unwrap();

        match &q.where_clause {
            Some(Expr::Not(inner)) => {
                assert_eq!(
                    **inner,
                    Expr::Property("n".to_string(), "exported".to_string())
                );
            }
            other => panic!("expected Not, got {:?}", other),
        }
    }

    #[test]
    fn return_with_alias() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) RETURN n.name AS funcName",
        )
        .unwrap();

        assert_eq!(q.return_clause.items.len(), 1);
        assert_eq!(
            q.return_clause.items[0].expr,
            Expr::Property("n".to_string(), "name".to_string())
        );
        assert_eq!(
            q.return_clause.items[0].alias,
            Some("funcName".to_string())
        );
    }

    #[test]
    fn aggregate_count() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION)-[:CALLS]->(m) RETURN n.name, COUNT(m) AS callCount",
        )
        .unwrap();

        assert_eq!(q.return_clause.items.len(), 2);
        assert_eq!(
            q.return_clause.items[0].expr,
            Expr::Property("n".to_string(), "name".to_string())
        );
        assert_eq!(
            q.return_clause.items[1].expr,
            Expr::FunctionCall("COUNT".to_string(), vec![Expr::Variable("m".to_string())])
        );
        assert_eq!(
            q.return_clause.items[1].alias,
            Some("callCount".to_string())
        );
    }

    #[test]
    fn count_star() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) RETURN COUNT(*)",
        )
        .unwrap();

        assert_eq!(
            q.return_clause.items[0].expr,
            Expr::FunctionCall("COUNT".to_string(), vec![Expr::Star])
        );
    }

    #[test]
    fn order_by_asc() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) RETURN n.name ORDER BY n.name",
        )
        .unwrap();

        let order = q.order_by.unwrap();
        assert_eq!(order.len(), 1);
        assert_eq!(order[0].0, Expr::Property("n".to_string(), "name".to_string()));
        assert_eq!(order[0].1, SortDir::Asc);
    }

    #[test]
    fn order_by_desc() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) RETURN n.name ORDER BY n.name DESC",
        )
        .unwrap();

        let order = q.order_by.unwrap();
        assert_eq!(order[0].1, SortDir::Desc);
    }

    #[test]
    fn limit_clause() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) RETURN n.name LIMIT 10",
        )
        .unwrap();

        assert_eq!(q.limit, Some(10));
    }

    #[test]
    fn full_complex_query() {
        let q = parse_cypher(
            "MATCH (f:FUNCTION)-[:CALLS]->(g) WHERE f.name = 'main' RETURN g.name, g.file LIMIT 5",
        )
        .unwrap();

        assert_eq!(
            q.match_clause.pattern.start.variable,
            Some("f".to_string())
        );
        assert_eq!(
            q.match_clause.pattern.start.labels,
            vec!["FUNCTION".to_string()]
        );
        assert_eq!(q.match_clause.pattern.segments.len(), 1);

        let (rel, node) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.direction, Direction::Outgoing);
        assert_eq!(rel.rel_types, vec!["CALLS".to_string()]);
        assert_eq!(node.variable, Some("g".to_string()));

        assert!(q.where_clause.is_some());
        assert_eq!(q.return_clause.items.len(), 2);
        assert_eq!(q.limit, Some(5));
    }

    #[test]
    fn is_null() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.semantic_id IS NULL RETURN n.name",
        )
        .unwrap();

        match &q.where_clause {
            Some(Expr::IsNull(inner)) => {
                assert_eq!(
                    **inner,
                    Expr::Property("n".to_string(), "semantic_id".to_string())
                );
            }
            other => panic!("expected IsNull, got {:?}", other),
        }
    }

    #[test]
    fn is_not_null() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.semantic_id IS NOT NULL RETURN n.name",
        )
        .unwrap();

        match &q.where_clause {
            Some(Expr::IsNotNull(inner)) => {
                assert_eq!(
                    **inner,
                    Expr::Property("n".to_string(), "semantic_id".to_string())
                );
            }
            other => panic!("expected IsNotNull, got {:?}", other),
        }
    }

    #[test]
    fn starts_with() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.name STARTS WITH 'get' RETURN n",
        )
        .unwrap();

        match &q.where_clause {
            Some(Expr::StartsWith(l, r)) => {
                assert_eq!(**l, Expr::Property("n".to_string(), "name".to_string()));
                assert_eq!(**r, Expr::Literal(CypherLiteral::Str("get".to_string())));
            }
            other => panic!("expected StartsWith, got {:?}", other),
        }
    }

    #[test]
    fn ends_with() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.file ENDS WITH '.ts' RETURN n",
        )
        .unwrap();

        match &q.where_clause {
            Some(Expr::EndsWith(l, r)) => {
                assert_eq!(**l, Expr::Property("n".to_string(), "file".to_string()));
                assert_eq!(**r, Expr::Literal(CypherLiteral::Str(".ts".to_string())));
            }
            other => panic!("expected EndsWith, got {:?}", other),
        }
    }

    #[test]
    fn case_insensitive_keywords() {
        let q = parse_cypher(
            "match (n:FUNCTION) where n.name = 'foo' return n.name limit 5",
        )
        .unwrap();

        assert_eq!(q.match_clause.pattern.start.labels, vec!["FUNCTION".to_string()]);
        assert!(q.where_clause.is_some());
        assert_eq!(q.limit, Some(5));
    }

    #[test]
    fn double_quoted_strings() {
        let q = parse_cypher(
            r#"MATCH (n:FUNCTION {name: "main"}) RETURN n"#,
        )
        .unwrap();

        let node = &q.match_clause.pattern.start;
        assert_eq!(
            node.properties[0].1,
            Expr::Literal(CypherLiteral::Str("main".to_string()))
        );
    }

    #[test]
    fn boolean_literal_in_where() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.exported = true RETURN n.name",
        )
        .unwrap();

        match &q.where_clause {
            Some(Expr::BinaryOp(l, BinOp::Eq, r)) => {
                assert_eq!(**l, Expr::Property("n".to_string(), "exported".to_string()));
                assert_eq!(**r, Expr::Literal(CypherLiteral::Bool(true)));
            }
            other => panic!("expected BinaryOp Eq, got {:?}", other),
        }
    }

    #[test]
    fn integer_literal_in_comparison() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.lineCount > 100 RETURN n.name",
        )
        .unwrap();

        match &q.where_clause {
            Some(Expr::BinaryOp(_, BinOp::Gt, r)) => {
                assert_eq!(**r, Expr::Literal(CypherLiteral::Int(100)));
            }
            other => panic!("expected BinaryOp Gt, got {:?}", other),
        }
    }

    #[test]
    fn or_expression() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.name = 'foo' OR n.name = 'bar' RETURN n",
        )
        .unwrap();

        match &q.where_clause {
            Some(Expr::Or(_, _)) => {}
            other => panic!("expected Or, got {:?}", other),
        }
    }

    #[test]
    fn comparison_operators() {
        // <>
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.name <> 'main' RETURN n",
        )
        .unwrap();
        match &q.where_clause {
            Some(Expr::BinaryOp(_, BinOp::Neq, _)) => {}
            other => panic!("expected Neq, got {:?}", other),
        }

        // <=
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.line <= 50 RETURN n",
        )
        .unwrap();
        match &q.where_clause {
            Some(Expr::BinaryOp(_, BinOp::Lte, _)) => {}
            other => panic!("expected Lte, got {:?}", other),
        }

        // >=
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.line >= 10 RETURN n",
        )
        .unwrap();
        match &q.where_clause {
            Some(Expr::BinaryOp(_, BinOp::Gte, _)) => {}
            other => panic!("expected Gte, got {:?}", other),
        }

        // <
        let q = parse_cypher(
            "MATCH (n:FUNCTION) WHERE n.line < 50 RETURN n",
        )
        .unwrap();
        match &q.where_clause {
            Some(Expr::BinaryOp(_, BinOp::Lt, _)) => {}
            other => panic!("expected Lt, got {:?}", other),
        }
    }

    #[test]
    fn empty_node_pattern() {
        let q = parse_cypher("MATCH (n)-[:CALLS]->(m) RETURN n, m").unwrap();
        assert_eq!(q.match_clause.pattern.start.variable, Some("n".to_string()));
        assert!(q.match_clause.pattern.start.labels.is_empty());
    }

    #[test]
    fn multiple_return_items() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) RETURN n.name, n.file, n.exported",
        )
        .unwrap();
        assert_eq!(q.return_clause.items.len(), 3);
    }

    #[test]
    fn namespaced_label() {
        let q = parse_cypher(
            "MATCH (n:http:route) RETURN n.name",
        )
        .unwrap();
        assert_eq!(q.match_clause.pattern.start.labels, vec!["http:route".to_string()]);
    }

    #[test]
    fn namespaced_edge_type() {
        let q = parse_cypher(
            "MATCH (a)-[:http:routes_to]->(b) RETURN a.name",
        )
        .unwrap();
        let (rel, _) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.rel_types, vec!["http:routes_to".to_string()]);
    }

    #[test]
    fn relationship_with_variable() {
        let q = parse_cypher(
            "MATCH (a)-[r:CALLS]->(b) RETURN r",
        )
        .unwrap();
        let (rel, _) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.variable, Some("r".to_string()));
        assert_eq!(rel.rel_types, vec!["CALLS".to_string()]);
    }

    #[test]
    fn multiple_order_by_items() {
        let q = parse_cypher(
            "MATCH (n:FUNCTION) RETURN n.name, n.file ORDER BY n.file ASC, n.name DESC",
        )
        .unwrap();
        let order = q.order_by.unwrap();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].1, SortDir::Asc);
        assert_eq!(order[1].1, SortDir::Desc);
    }

    // ========================================================================
    // Error cases
    // ========================================================================

    #[test]
    fn error_empty_input() {
        let err = parse_cypher("").unwrap_err();
        assert!(err.message.contains("expected keyword 'MATCH'"));
    }

    #[test]
    fn error_missing_match() {
        let err = parse_cypher("RETURN n.name").unwrap_err();
        assert!(err.message.contains("expected keyword 'MATCH'"));
    }

    #[test]
    fn error_missing_return() {
        let err = parse_cypher("MATCH (n:FUNCTION)").unwrap_err();
        assert!(err.message.contains("expected keyword 'RETURN'"));
    }

    #[test]
    fn error_invalid_syntax() {
        let err = parse_cypher("MATCH (n:FUNCTION) RETURN @@@").unwrap_err();
        assert!(err.message.contains("unexpected character"));
    }

    #[test]
    fn error_trailing_input() {
        let err = parse_cypher("MATCH (n:FUNCTION) RETURN n.name GARBAGE").unwrap_err();
        assert!(err.message.contains("unexpected input after query"));
    }

    #[test]
    fn line_comment_ignored() {
        let q = parse_cypher(
            "// Find all functions\nMATCH (n:FUNCTION) RETURN n.name",
        )
        .unwrap();
        assert_eq!(q.match_clause.pattern.start.labels, vec!["FUNCTION".to_string()]);
    }
}

mod value_tests {
    use super::*;

    #[test]
    fn node_property_access() {
        let node = CypherValue::Node {
            id: 42,
            node_type: "FUNCTION".to_string(),
            name: "main".to_string(),
            file: "src/index.ts".to_string(),
            metadata: Some(r#"{"lineCount": 25}"#.to_string()),
            semantic_id: Some("main@src/index.ts".to_string()),
            exported: true,
        };

        assert_eq!(node.property("name"), CypherValue::Str("main".to_string()));
        assert_eq!(node.property("type"), CypherValue::Str("FUNCTION".to_string()));
        assert_eq!(node.property("file"), CypherValue::Str("src/index.ts".to_string()));
        assert_eq!(node.property("exported"), CypherValue::Bool(true));
        assert_eq!(
            node.property("semanticId"),
            CypherValue::Str("main@src/index.ts".to_string())
        );
        assert_eq!(node.property("lineCount"), CypherValue::Int(25));
        assert_eq!(node.property("nonexistent"), CypherValue::Null);
    }

    #[test]
    fn value_equality() {
        assert_eq!(CypherValue::Int(1), CypherValue::Int(1));
        assert_eq!(CypherValue::Str("a".into()), CypherValue::Str("a".into()));
        assert_eq!(CypherValue::Null, CypherValue::Null);
        assert_eq!(CypherValue::Int(1), CypherValue::Float(1.0));
        assert_ne!(CypherValue::Int(1), CypherValue::Str("1".into()));
    }

    #[test]
    fn value_ordering() {
        assert_eq!(
            CypherValue::Int(1).partial_cmp_values(&CypherValue::Int(2)),
            Some(std::cmp::Ordering::Less)
        );
        assert_eq!(
            CypherValue::Str("b".into()).partial_cmp_values(&CypherValue::Str("a".into())),
            Some(std::cmp::Ordering::Greater)
        );
        assert_eq!(
            CypherValue::Null.partial_cmp_values(&CypherValue::Int(1)),
            Some(std::cmp::Ordering::Less)
        );
    }

    #[test]
    fn value_truthiness() {
        assert!(!CypherValue::Null.is_truthy());
        assert!(!CypherValue::Bool(false).is_truthy());
        assert!(CypherValue::Bool(true).is_truthy());
        assert!(!CypherValue::Int(0).is_truthy());
        assert!(CypherValue::Int(1).is_truthy());
        assert!(!CypherValue::Str("".into()).is_truthy());
        assert!(CypherValue::Str("x".into()).is_truthy());
    }

    #[test]
    fn json_round_trip() {
        let val = CypherValue::Int(42);
        let json = val.to_json();
        assert_eq!(json, serde_json::json!(42));

        let val = CypherValue::Str("hello".into());
        let json = val.to_json();
        assert_eq!(json, serde_json::json!("hello"));

        let val = CypherValue::Null;
        let json = val.to_json();
        assert_eq!(json, serde_json::Value::Null);
    }
}

mod executor_tests {
    use super::*;
    use crate::cypher::executor::*;
    use crate::datalog::EvalLimits;
    use crate::graph::GraphEngineV2;
    use crate::storage::{NodeRecord, EdgeRecord};

    /// Helper: create a test graph with known nodes and edges.
    ///
    /// Nodes:
    ///   id=1: FUNCTION "main"     in "src/app.js"   (exported=true)
    ///   id=2: FUNCTION "helper"   in "src/utils.js"  (exported=false)
    ///   id=3: CLASS    "User"     in "src/models.js" (exported=true)
    ///   id=4: FUNCTION "internal" in "src/utils.js"  (exported=false)
    ///
    /// Edges:
    ///   main -[CALLS]-> helper
    ///   main -[CALLS]-> User
    ///   helper -[CALLS]-> internal
    fn create_test_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("FUNCTION".to_string()),
                name: Some("main".to_string()),
                file: Some("src/app.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: true,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"lineCount": 42}"#.to_string()),
                semantic_id: Some("main@src/app.js".to_string()),
            },
            NodeRecord {
                id: 2,
                node_type: Some("FUNCTION".to_string()),
                name: Some("helper".to_string()),
                file: Some("src/utils.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: 3,
                node_type: Some("CLASS".to_string()),
                name: Some("User".to_string()),
                file: Some("src/models.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: true,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: 4,
                node_type: Some("FUNCTION".to_string()),
                name: Some("internal".to_string()),
                file: Some("src/utils.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
        ]);

        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 1,
                    dst: 2,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                EdgeRecord {
                    src: 1,
                    dst: 3,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                EdgeRecord {
                    src: 2,
                    dst: 4,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
            ],
            true, // skip_validation for test speed
        );

        engine
    }

    fn default_limits() -> EvalLimits {
        EvalLimits::default()
    }

    // ── NodeScan tests ──────────────────────────────────────────────────

    #[test]
    fn node_scan_by_type() {
        let engine = create_test_graph();
        let limits = default_limits();
        let mut scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let mut names = Vec::new();
        while let Some(rec) = scan.next().unwrap() {
            let val = rec.get("n").unwrap().property("name");
            if let CypherValue::Str(s) = val {
                names.push(s);
            }
        }
        names.sort();
        assert_eq!(names, vec!["helper", "internal", "main"]);
    }

    #[test]
    fn node_scan_with_inline_name_property() {
        let engine = create_test_graph();
        let limits = default_limits();
        let mut scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![("name".to_string(), Expr::Literal(CypherLiteral::Str("main".to_string())))],
            &limits,
        );

        let rec = scan.next().unwrap().unwrap();
        let name = rec.get("n").unwrap().property("name");
        assert_eq!(name, CypherValue::Str("main".to_string()));

        // Only one match.
        assert!(scan.next().unwrap().is_none());
    }

    #[test]
    fn node_scan_class_type() {
        let engine = create_test_graph();
        let limits = default_limits();
        let mut scan = NodeScan::new(
            &engine,
            Some("c".to_string()),
            vec!["CLASS".to_string()],
            vec![],
            &limits,
        );

        let rec = scan.next().unwrap().unwrap();
        let name = rec.get("c").unwrap().property("name");
        assert_eq!(name, CypherValue::Str("User".to_string()));

        assert!(scan.next().unwrap().is_none());
    }

    #[test]
    fn node_scan_no_match() {
        let engine = create_test_graph();
        let limits = default_limits();
        let mut scan = NodeScan::new(
            &engine,
            Some("x".to_string()),
            vec!["NONEXISTENT".to_string()],
            vec![],
            &limits,
        );

        assert!(scan.next().unwrap().is_none());
    }

    // ── Expand tests ────────────────────────────────────────────────────

    #[test]
    fn expand_outgoing() {
        let engine = create_test_graph();
        let limits = default_limits();

        // Scan for "main" node.
        let scan = NodeScan::new(
            &engine,
            Some("a".to_string()),
            vec!["FUNCTION".to_string()],
            vec![("name".to_string(), Expr::Literal(CypherLiteral::Str("main".to_string())))],
            &limits,
        );

        // Expand outgoing CALLS edges.
        let mut expand = Expand::new(
            Box::new(scan),
            &engine,
            "a".to_string(),
            Some("b".to_string()),
            None,
            vec!["CALLS".to_string()],
            Direction::Outgoing,
            &limits,
        );

        let mut target_names = Vec::new();
        while let Some(rec) = expand.next().unwrap() {
            let val = rec.get("b").unwrap().property("name");
            if let CypherValue::Str(s) = val {
                target_names.push(s);
            }
        }
        target_names.sort();
        assert_eq!(target_names, vec!["User", "helper"]);
    }

    #[test]
    fn expand_incoming() {
        let engine = create_test_graph();
        let limits = default_limits();

        // Scan for "helper" node.
        let scan = NodeScan::new(
            &engine,
            Some("a".to_string()),
            vec!["FUNCTION".to_string()],
            vec![("name".to_string(), Expr::Literal(CypherLiteral::Str("helper".to_string())))],
            &limits,
        );

        // Expand incoming CALLS edges (who calls helper?).
        let mut expand = Expand::new(
            Box::new(scan),
            &engine,
            "a".to_string(),
            Some("b".to_string()),
            None,
            vec!["CALLS".to_string()],
            Direction::Incoming,
            &limits,
        );

        let rec = expand.next().unwrap().unwrap();
        let caller = rec.get("b").unwrap().property("name");
        assert_eq!(caller, CypherValue::Str("main".to_string()));

        assert!(expand.next().unwrap().is_none());
    }

    #[test]
    fn expand_both_directions() {
        let engine = create_test_graph();
        let limits = default_limits();

        // Scan for "helper": has incoming from main and outgoing to internal.
        let scan = NodeScan::new(
            &engine,
            Some("a".to_string()),
            vec!["FUNCTION".to_string()],
            vec![("name".to_string(), Expr::Literal(CypherLiteral::Str("helper".to_string())))],
            &limits,
        );

        let mut expand = Expand::new(
            Box::new(scan),
            &engine,
            "a".to_string(),
            Some("b".to_string()),
            None,
            vec!["CALLS".to_string()],
            Direction::Both,
            &limits,
        );

        let mut connected_names = Vec::new();
        while let Some(rec) = expand.next().unwrap() {
            let val = rec.get("b").unwrap().property("name");
            if let CypherValue::Str(s) = val {
                connected_names.push(s);
            }
        }
        connected_names.sort();
        // main calls helper (outgoing from helper's perspective = incoming, plus helper calls internal)
        assert_eq!(connected_names, vec!["internal", "main"]);
    }

    #[test]
    fn expand_no_matching_edges() {
        let engine = create_test_graph();
        let limits = default_limits();

        // Scan for "internal" — has no outgoing CALLS edges.
        let scan = NodeScan::new(
            &engine,
            Some("a".to_string()),
            vec!["FUNCTION".to_string()],
            vec![("name".to_string(), Expr::Literal(CypherLiteral::Str("internal".to_string())))],
            &limits,
        );

        let mut expand = Expand::new(
            Box::new(scan),
            &engine,
            "a".to_string(),
            Some("b".to_string()),
            None,
            vec!["CALLS".to_string()],
            Direction::Outgoing,
            &limits,
        );

        assert!(expand.next().unwrap().is_none());
    }

    // ── Filter tests ────────────────────────────────────────────────────

    #[test]
    fn filter_by_name_equality() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let predicate = Expr::BinaryOp(
            Box::new(Expr::Property("n".to_string(), "name".to_string())),
            BinOp::Eq,
            Box::new(Expr::Literal(CypherLiteral::Str("helper".to_string()))),
        );
        let mut filter = Filter::new(Box::new(scan), predicate);

        let rec = filter.next().unwrap().unwrap();
        assert_eq!(
            rec.get("n").unwrap().property("name"),
            CypherValue::Str("helper".to_string())
        );
        assert!(filter.next().unwrap().is_none());
    }

    #[test]
    fn filter_contains() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let predicate = Expr::Contains(
            Box::new(Expr::Property("n".to_string(), "file".to_string())),
            Box::new(Expr::Literal(CypherLiteral::Str("utils".to_string()))),
        );
        let mut filter = Filter::new(Box::new(scan), predicate);

        let mut names = Vec::new();
        while let Some(rec) = filter.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("n").unwrap().property("name") {
                names.push(s);
            }
        }
        names.sort();
        assert_eq!(names, vec!["helper", "internal"]);
    }

    #[test]
    fn filter_starts_with() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let predicate = Expr::StartsWith(
            Box::new(Expr::Property("n".to_string(), "name".to_string())),
            Box::new(Expr::Literal(CypherLiteral::Str("hel".to_string()))),
        );
        let mut filter = Filter::new(Box::new(scan), predicate);

        let rec = filter.next().unwrap().unwrap();
        assert_eq!(
            rec.get("n").unwrap().property("name"),
            CypherValue::Str("helper".to_string())
        );
        assert!(filter.next().unwrap().is_none());
    }

    #[test]
    fn filter_ends_with() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let predicate = Expr::EndsWith(
            Box::new(Expr::Property("n".to_string(), "file".to_string())),
            Box::new(Expr::Literal(CypherLiteral::Str("app.js".to_string()))),
        );
        let mut filter = Filter::new(Box::new(scan), predicate);

        let rec = filter.next().unwrap().unwrap();
        assert_eq!(
            rec.get("n").unwrap().property("name"),
            CypherValue::Str("main".to_string())
        );
        assert!(filter.next().unwrap().is_none());
    }

    #[test]
    fn filter_exported_boolean() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let predicate = Expr::BinaryOp(
            Box::new(Expr::Property("n".to_string(), "exported".to_string())),
            BinOp::Eq,
            Box::new(Expr::Literal(CypherLiteral::Bool(true))),
        );
        let mut filter = Filter::new(Box::new(scan), predicate);

        let rec = filter.next().unwrap().unwrap();
        assert_eq!(
            rec.get("n").unwrap().property("name"),
            CypherValue::Str("main".to_string())
        );
        // main is the only exported FUNCTION.
        assert!(filter.next().unwrap().is_none());
    }

    #[test]
    fn filter_is_null() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        // Filter for nodes where metadata field "lineCount" IS NULL.
        // Only "main" has lineCount in its metadata; helper and internal don't.
        let predicate = Expr::IsNull(Box::new(Expr::Property(
            "n".to_string(),
            "lineCount".to_string(),
        )));
        let mut filter = Filter::new(Box::new(scan), predicate);

        let mut names = Vec::new();
        while let Some(rec) = filter.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("n").unwrap().property("name") {
                names.push(s);
            }
        }
        names.sort();
        // helper and internal have no lineCount metadata.
        assert_eq!(names, vec!["helper", "internal"]);
    }

    #[test]
    fn filter_is_not_null() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        // Only "main" has lineCount metadata.
        let predicate = Expr::IsNotNull(Box::new(Expr::Property(
            "n".to_string(),
            "lineCount".to_string(),
        )));
        let mut filter = Filter::new(Box::new(scan), predicate);

        let rec = filter.next().unwrap().unwrap();
        assert_eq!(
            rec.get("n").unwrap().property("name"),
            CypherValue::Str("main".to_string())
        );
        assert!(filter.next().unwrap().is_none());
    }

    #[test]
    fn filter_and_logic() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        // name CONTAINS "l" AND exported = false
        let predicate = Expr::And(
            Box::new(Expr::Contains(
                Box::new(Expr::Property("n".to_string(), "name".to_string())),
                Box::new(Expr::Literal(CypherLiteral::Str("l".to_string()))),
            )),
            Box::new(Expr::BinaryOp(
                Box::new(Expr::Property("n".to_string(), "exported".to_string())),
                BinOp::Eq,
                Box::new(Expr::Literal(CypherLiteral::Bool(false))),
            )),
        );
        let mut filter = Filter::new(Box::new(scan), predicate);

        let mut names = Vec::new();
        while let Some(rec) = filter.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("n").unwrap().property("name") {
                names.push(s);
            }
        }
        names.sort();
        // "helper" and "internal" both contain "l" and exported=false.
        assert_eq!(names, vec!["helper", "internal"]);
    }

    #[test]
    fn filter_or_logic() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        // name = "main" OR name = "internal"
        let predicate = Expr::Or(
            Box::new(Expr::BinaryOp(
                Box::new(Expr::Property("n".to_string(), "name".to_string())),
                BinOp::Eq,
                Box::new(Expr::Literal(CypherLiteral::Str("main".to_string()))),
            )),
            Box::new(Expr::BinaryOp(
                Box::new(Expr::Property("n".to_string(), "name".to_string())),
                BinOp::Eq,
                Box::new(Expr::Literal(CypherLiteral::Str("internal".to_string()))),
            )),
        );
        let mut filter = Filter::new(Box::new(scan), predicate);

        let mut names = Vec::new();
        while let Some(rec) = filter.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("n").unwrap().property("name") {
                names.push(s);
            }
        }
        names.sort();
        assert_eq!(names, vec!["internal", "main"]);
    }

    #[test]
    fn filter_not_logic() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        // NOT exported
        let predicate = Expr::Not(Box::new(Expr::Property(
            "n".to_string(),
            "exported".to_string(),
        )));
        let mut filter = Filter::new(Box::new(scan), predicate);

        let mut names = Vec::new();
        while let Some(rec) = filter.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("n").unwrap().property("name") {
                names.push(s);
            }
        }
        names.sort();
        assert_eq!(names, vec!["helper", "internal"]);
    }

    // ── Project tests ───────────────────────────────────────────────────

    #[test]
    fn project_properties() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![("name".to_string(), Expr::Literal(CypherLiteral::Str("main".to_string())))],
            &limits,
        );

        let items = vec![
            ReturnItem {
                expr: Expr::Property("n".to_string(), "name".to_string()),
                alias: Some("funcName".to_string()),
            },
            ReturnItem {
                expr: Expr::Property("n".to_string(), "file".to_string()),
                alias: None,
            },
        ];
        let mut project = Project::new(Box::new(scan), items);

        let rec = project.next().unwrap().unwrap();
        assert_eq!(
            rec.get("funcName").unwrap(),
            &CypherValue::Str("main".to_string())
        );
        assert_eq!(
            rec.get("n.file").unwrap(),
            &CypherValue::Str("src/app.js".to_string())
        );
        // Original "n" variable should NOT be in the projected record.
        assert!(rec.get("n").is_none());

        assert!(project.next().unwrap().is_none());
    }

    // ── Limit tests ─────────────────────────────────────────────────────

    #[test]
    fn limit_caps_output() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let mut lim = Limit::new(Box::new(scan), 2);

        let r1 = lim.next().unwrap();
        assert!(r1.is_some());
        let r2 = lim.next().unwrap();
        assert!(r2.is_some());
        // Third call should return None even though there are 3 FUNCTION nodes.
        let r3 = lim.next().unwrap();
        assert!(r3.is_none());
    }

    #[test]
    fn limit_zero_returns_nothing() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let mut lim = Limit::new(Box::new(scan), 0);
        assert!(lim.next().unwrap().is_none());
    }

    // ── Sort tests ──────────────────────────────────────────────────────

    #[test]
    fn sort_ascending() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let order = vec![(Expr::Property("n".to_string(), "name".to_string()), SortDir::Asc)];
        let mut sort = Sort::new(Box::new(scan), order, &limits);

        let mut names = Vec::new();
        while let Some(rec) = sort.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("n").unwrap().property("name") {
                names.push(s);
            }
        }
        assert_eq!(names, vec!["helper", "internal", "main"]);
    }

    #[test]
    fn sort_descending() {
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let order = vec![(Expr::Property("n".to_string(), "name".to_string()), SortDir::Desc)];
        let mut sort = Sort::new(Box::new(scan), order, &limits);

        let mut names = Vec::new();
        while let Some(rec) = sort.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("n").unwrap().property("name") {
                names.push(s);
            }
        }
        assert_eq!(names, vec!["main", "internal", "helper"]);
    }

    // ── HashAggregate tests ─────────────────────────────────────────────

    #[test]
    fn aggregate_count_with_group_key() {
        let engine = create_test_graph();
        let limits = default_limits();

        // Scan all FUNCTIONs, group by file, count per group.
        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let group_keys = vec![ReturnItem {
            expr: Expr::Property("n".to_string(), "file".to_string()),
            alias: Some("file".to_string()),
        }];
        let aggregates = vec![AggregateItem {
            function: "COUNT".to_string(),
            arg: Expr::Variable("n".to_string()),
            alias: "cnt".to_string(),
        }];

        let mut agg = HashAggregate::new(Box::new(scan), group_keys, aggregates, &limits);

        let mut results: Vec<(String, i64)> = Vec::new();
        while let Some(rec) = agg.next().unwrap() {
            let file = match rec.get("file").unwrap() {
                CypherValue::Str(s) => s.clone(),
                other => panic!("expected Str, got {:?}", other),
            };
            let cnt = match rec.get("cnt").unwrap() {
                CypherValue::Int(i) => *i,
                other => panic!("expected Int, got {:?}", other),
            };
            results.push((file, cnt));
        }
        results.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            results,
            vec![
                ("src/app.js".to_string(), 1),
                ("src/utils.js".to_string(), 2),
            ]
        );
    }

    #[test]
    fn aggregate_count_star_no_group_keys() {
        let engine = create_test_graph();
        let limits = default_limits();

        // COUNT(*) over all FUNCTIONs.
        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let group_keys = vec![];
        let aggregates = vec![AggregateItem {
            function: "COUNT".to_string(),
            arg: Expr::Star,
            alias: "total".to_string(),
        }];

        let mut agg = HashAggregate::new(Box::new(scan), group_keys, aggregates, &limits);

        let rec = agg.next().unwrap().unwrap();
        assert_eq!(rec.get("total").unwrap(), &CypherValue::Int(3));
        assert!(agg.next().unwrap().is_none());
    }

    #[test]
    fn aggregate_count_star_no_input() {
        // COUNT(*) with no input rows should yield one row with 0.
        let engine = create_test_graph();
        let limits = default_limits();

        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["NONEXISTENT".to_string()],
            vec![],
            &limits,
        );

        let group_keys = vec![];
        let aggregates = vec![AggregateItem {
            function: "COUNT".to_string(),
            arg: Expr::Star,
            alias: "total".to_string(),
        }];

        let mut agg = HashAggregate::new(Box::new(scan), group_keys, aggregates, &limits);

        let rec = agg.next().unwrap().unwrap();
        assert_eq!(rec.get("total").unwrap(), &CypherValue::Int(0));
        assert!(agg.next().unwrap().is_none());
    }

    // ── VarLengthExpand tests ───────────────────────────────────────────

    #[test]
    fn var_length_expand_1_to_2() {
        let engine = create_test_graph();
        let limits = default_limits();

        // From "main", follow CALLS 1..2 hops.
        let scan = NodeScan::new(
            &engine,
            Some("a".to_string()),
            vec!["FUNCTION".to_string()],
            vec![("name".to_string(), Expr::Literal(CypherLiteral::Str("main".to_string())))],
            &limits,
        );

        let mut expand = VarLengthExpand::new(
            Box::new(scan),
            &engine,
            "a".to_string(),
            Some("b".to_string()),
            vec!["CALLS".to_string()],
            Direction::Outgoing,
            1,
            2,
            &limits,
        );

        let mut names = Vec::new();
        while let Some(rec) = expand.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("b").unwrap().property("name") {
                names.push(s);
            }
        }
        names.sort();
        // Depth 1: helper, User. Depth 2: internal.
        assert_eq!(names, vec!["User", "helper", "internal"]);
    }

    #[test]
    fn var_length_expand_min_2() {
        let engine = create_test_graph();
        let limits = default_limits();

        // From "main", follow CALLS 2..3 hops — only "internal" is at depth 2.
        let scan = NodeScan::new(
            &engine,
            Some("a".to_string()),
            vec!["FUNCTION".to_string()],
            vec![("name".to_string(), Expr::Literal(CypherLiteral::Str("main".to_string())))],
            &limits,
        );

        let mut expand = VarLengthExpand::new(
            Box::new(scan),
            &engine,
            "a".to_string(),
            Some("b".to_string()),
            vec!["CALLS".to_string()],
            Direction::Outgoing,
            2,
            3,
            &limits,
        );

        let mut names = Vec::new();
        while let Some(rec) = expand.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("b").unwrap().property("name") {
                names.push(s);
            }
        }
        assert_eq!(names, vec!["internal"]);
    }

    // ── eval_expr unit tests ────────────────────────────────────────────

    #[test]
    fn eval_expr_literal() {
        let rec = Record::new();
        let result = eval_expr(
            &Expr::Literal(CypherLiteral::Int(42)),
            &rec,
        );
        assert_eq!(result, CypherValue::Int(42));
    }

    #[test]
    fn eval_expr_property_on_node() {
        let mut rec = Record::new();
        rec.insert("n".to_string(), CypherValue::Node {
            id: 1,
            node_type: "FUNCTION".to_string(),
            name: "foo".to_string(),
            file: "bar.js".to_string(),
            metadata: None,
            semantic_id: None,
            exported: false,
        });

        let result = eval_expr(
            &Expr::Property("n".to_string(), "name".to_string()),
            &rec,
        );
        assert_eq!(result, CypherValue::Str("foo".to_string()));
    }

    #[test]
    fn eval_expr_comparison_operators() {
        let rec = Record::new();

        // Int < Int
        let result = eval_expr(
            &Expr::BinaryOp(
                Box::new(Expr::Literal(CypherLiteral::Int(1))),
                BinOp::Lt,
                Box::new(Expr::Literal(CypherLiteral::Int(2))),
            ),
            &rec,
        );
        assert_eq!(result, CypherValue::Bool(true));

        // Int >= Int
        let result = eval_expr(
            &Expr::BinaryOp(
                Box::new(Expr::Literal(CypherLiteral::Int(5))),
                BinOp::Gte,
                Box::new(Expr::Literal(CypherLiteral::Int(5))),
            ),
            &rec,
        );
        assert_eq!(result, CypherValue::Bool(true));

        // Neq
        let result = eval_expr(
            &Expr::BinaryOp(
                Box::new(Expr::Literal(CypherLiteral::Str("a".to_string()))),
                BinOp::Neq,
                Box::new(Expr::Literal(CypherLiteral::Str("b".to_string()))),
            ),
            &rec,
        );
        assert_eq!(result, CypherValue::Bool(true));
    }

    #[test]
    fn eval_expr_variable_lookup() {
        let mut rec = Record::new();
        rec.insert("x".to_string(), CypherValue::Int(99));

        let result = eval_expr(&Expr::Variable("x".to_string()), &rec);
        assert_eq!(result, CypherValue::Int(99));

        // Missing variable returns Null.
        let result = eval_expr(&Expr::Variable("missing".to_string()), &rec);
        assert_eq!(result, CypherValue::Null);
    }

    // ── Composite pipeline tests ────────────────────────────────────────

    #[test]
    fn pipeline_scan_filter_sort_limit_project() {
        let engine = create_test_graph();
        let limits = default_limits();

        // Scan all FUNCTIONs, filter non-exported, sort by name desc, limit 1,
        // project name.
        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );

        let filter = Filter::new(
            Box::new(scan),
            Expr::Not(Box::new(Expr::Property("n".to_string(), "exported".to_string()))),
        );

        let sort = Sort::new(
            Box::new(filter),
            vec![(Expr::Property("n".to_string(), "name".to_string()), SortDir::Desc)],
            &limits,
        );

        let limit = Limit::new(Box::new(sort), 1);

        let mut project = Project::new(
            Box::new(limit),
            vec![ReturnItem {
                expr: Expr::Property("n".to_string(), "name".to_string()),
                alias: Some("name".to_string()),
            }],
        );

        let rec = project.next().unwrap().unwrap();
        // Non-exported FUNCTIONs: "helper", "internal". Desc: "internal" first.
        assert_eq!(
            rec.get("name").unwrap(),
            &CypherValue::Str("internal".to_string())
        );
        assert!(project.next().unwrap().is_none());
    }

    #[test]
    fn pipeline_expand_then_filter() {
        let engine = create_test_graph();
        let limits = default_limits();

        // From main, follow CALLS, filter targets in "src/utils.js".
        let scan = NodeScan::new(
            &engine,
            Some("a".to_string()),
            vec!["FUNCTION".to_string()],
            vec![("name".to_string(), Expr::Literal(CypherLiteral::Str("main".to_string())))],
            &limits,
        );

        let expand = Expand::new(
            Box::new(scan),
            &engine,
            "a".to_string(),
            Some("b".to_string()),
            None,
            vec!["CALLS".to_string()],
            Direction::Outgoing,
            &limits,
        );

        let mut filter = Filter::new(
            Box::new(expand),
            Expr::BinaryOp(
                Box::new(Expr::Property("b".to_string(), "file".to_string())),
                BinOp::Eq,
                Box::new(Expr::Literal(CypherLiteral::Str(
                    "src/utils.js".to_string(),
                ))),
            ),
        );

        let rec = filter.next().unwrap().unwrap();
        assert_eq!(
            rec.get("b").unwrap().property("name"),
            CypherValue::Str("helper".to_string())
        );
        assert!(filter.next().unwrap().is_none());
    }
}

/// Integration tests: full pipeline parse → plan → execute.
mod integration_tests {
    use super::*;
    use crate::graph::GraphEngineV2;
    use crate::storage::{NodeRecord, EdgeRecord};
    use crate::datalog::EvalLimits;

    /// Create a test graph for integration tests.
    ///
    /// Nodes:
    ///   id=10: FUNCTION "main"      in "src/app.js"    (exported=true)
    ///   id=11: FUNCTION "helper"    in "src/utils.js"  (exported=false)
    ///   id=12: FUNCTION "validate"  in "src/utils.js"  (exported=true)
    ///   id=13: CLASS    "User"      in "src/models.js" (exported=true)
    ///
    /// Edges:
    ///   main     -[CALLS]-> helper
    ///   main     -[CALLS]-> validate
    ///   helper   -[CALLS]-> validate
    ///   validate -[READS_FROM]-> User
    fn create_test_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 10,
                node_type: Some("FUNCTION".to_string()),
                name: Some("main".to_string()),
                file: Some("src/app.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: true,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"lineCount": 42}"#.to_string()),
                semantic_id: Some("main@src/app.js".to_string()),
            },
            NodeRecord {
                id: 11,
                node_type: Some("FUNCTION".to_string()),
                name: Some("helper".to_string()),
                file: Some("src/utils.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: 12,
                node_type: Some("FUNCTION".to_string()),
                name: Some("validate".to_string()),
                file: Some("src/utils.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: true,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: 13,
                node_type: Some("CLASS".to_string()),
                name: Some("User".to_string()),
                file: Some("src/models.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: true,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
        ]);

        engine.add_edges(
            vec![
                EdgeRecord {
                    src: 10,
                    dst: 11,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                EdgeRecord {
                    src: 10,
                    dst: 12,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                EdgeRecord {
                    src: 11,
                    dst: 12,
                    edge_type: Some("CALLS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                EdgeRecord {
                    src: 12,
                    dst: 13,
                    edge_type: Some("READS_FROM".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
            ],
            true, // skip_validation for test speed
        );

        engine
    }

    /// Helper: collect a single string column from CypherResult, sorted.
    fn collect_string_column(result: &CypherResult, col_idx: usize) -> Vec<String> {
        let mut vals: Vec<String> = result
            .rows
            .iter()
            .map(|row| {
                row[col_idx]
                    .as_str()
                    .unwrap_or("<null>")
                    .to_string()
            })
            .collect();
        vals.sort();
        vals
    }

    #[test]
    fn simple_node_scan() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name LIMIT 5",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["n.name"]);
        assert!(result.row_count <= 5);
        // All 3 FUNCTION nodes should be returned.
        assert_eq!(result.row_count, 3);

        let names = collect_string_column(&result, 0);
        assert_eq!(names, vec!["helper", "main", "validate"]);
    }

    #[test]
    fn node_with_inline_filter() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'main'}) RETURN n.name, n.file",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["n.name", "n.file"]);
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!("main"));
        assert_eq!(result.rows[0][1], serde_json::json!("src/app.js"));
    }

    #[test]
    fn relationship_query() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (f:FUNCTION)-[:CALLS]->(g) RETURN f.name, g.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["f.name", "g.name"]);
        // main->helper, main->validate, helper->validate = 3 results
        assert_eq!(result.row_count, 3);

        // Collect pairs (f.name, g.name) and sort for determinism.
        let mut pairs: Vec<(String, String)> = result
            .rows
            .iter()
            .map(|row| {
                (
                    row[0].as_str().unwrap().to_string(),
                    row[1].as_str().unwrap().to_string(),
                )
            })
            .collect();
        pairs.sort();

        assert_eq!(
            pairs,
            vec![
                ("helper".to_string(), "validate".to_string()),
                ("main".to_string(), "helper".to_string()),
                ("main".to_string(), "validate".to_string()),
            ]
        );
    }

    #[test]
    fn where_clause() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.name = 'main' RETURN n.name, n.file",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!("main"));
        assert_eq!(result.rows[0][1], serde_json::json!("src/app.js"));
    }

    #[test]
    fn where_contains() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.file CONTAINS 'utils' RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 2);
        let names = collect_string_column(&result, 0);
        assert_eq!(names, vec!["helper", "validate"]);
    }

    #[test]
    fn count_aggregate() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (f:FUNCTION)-[:CALLS]->(g) RETURN f.name, COUNT(g) AS calls",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["f.name", "calls"]);

        // Collect (name, count) pairs.
        let mut pairs: Vec<(String, i64)> = result
            .rows
            .iter()
            .map(|row| {
                (
                    row[0].as_str().unwrap().to_string(),
                    row[1].as_i64().unwrap(),
                )
            })
            .collect();
        pairs.sort_by_key(|p| p.0.clone());

        // helper -> validate (1 call), main -> helper + validate (2 calls)
        assert_eq!(
            pairs,
            vec![
                ("helper".to_string(), 1),
                ("main".to_string(), 2),
            ]
        );
    }

    #[test]
    fn count_star_aggregate() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN COUNT(*) AS total",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["total"]);
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!(3));
    }

    #[test]
    fn order_by() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name ORDER BY n.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 3);
        let names: Vec<&str> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["helper", "main", "validate"]);
    }

    #[test]
    fn order_by_desc() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name ORDER BY n.name DESC",
            EvalLimits::none(),
        )
        .unwrap();

        let names: Vec<&str> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["validate", "main", "helper"]);
    }

    #[test]
    fn limit_clause() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name LIMIT 2",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 2);
    }

    #[test]
    fn complex_query() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (f:FUNCTION)-[:CALLS]->(g) WHERE f.name = 'main' RETURN g.name, g.file LIMIT 5",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["g.name", "g.file"]);
        // main CALLS helper and validate
        assert_eq!(result.row_count, 2);

        let mut names = collect_string_column(&result, 0);
        names.sort();
        assert_eq!(names, vec!["helper", "validate"]);
    }

    #[test]
    fn incoming_relationship() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n)<-[:CALLS]-(caller:FUNCTION) WHERE n.name = 'validate' RETURN caller.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["caller.name"]);
        // Both main and helper call validate.
        assert_eq!(result.row_count, 2);

        let names = collect_string_column(&result, 0);
        assert_eq!(names, vec!["helper", "main"]);
    }

    #[test]
    fn variable_length_path() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (a:FUNCTION)-[:CALLS*1..3]->(b) WHERE a.name = 'main' RETURN b.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["b.name"]);
        // Depth 1: helper, validate. Depth 2: validate (from helper), but already visited.
        // BFS with visited set: main->helper(1), main->validate(1), helper->validate(2, already visited).
        // So only helper and validate at depth >= 1.
        let names = collect_string_column(&result, 0);
        assert_eq!(names, vec!["helper", "validate"]);
    }

    #[test]
    fn relationship_with_typed_target() {
        let engine = create_test_graph();
        // MATCH a FUNCTION that CALLS a CLASS
        let result = execute(
            &engine,
            "MATCH (f:FUNCTION)-[:READS_FROM]->(c:CLASS) RETURN f.name, c.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["f.name", "c.name"]);
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!("validate"));
        assert_eq!(result.rows[0][1], serde_json::json!("User"));
    }

    #[test]
    fn order_by_with_limit() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name ORDER BY n.name LIMIT 2",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 2);
        let names: Vec<&str> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap())
            .collect();
        // Sorted ascending, limit 2: helper, main
        assert_eq!(names, vec!["helper", "main"]);
    }

    #[test]
    fn return_with_alias() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'main'}) RETURN n.name AS funcName, n.file AS path",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["funcName", "path"]);
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!("main"));
        assert_eq!(result.rows[0][1], serde_json::json!("src/app.js"));
    }

    #[test]
    fn where_with_and() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.file CONTAINS 'utils' AND n.exported = true RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();

        // Only validate is in utils.js AND exported.
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!("validate"));
    }

    #[test]
    fn where_starts_with() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.name STARTS WITH 'val' RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!("validate"));
    }

    #[test]
    fn count_star_no_input() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:NONEXISTENT) RETURN COUNT(*) AS total",
            EvalLimits::none(),
        )
        .unwrap();

        // COUNT(*) with no matching rows should return 0.
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!(0));
    }

    #[test]
    fn multi_hop_query() {
        let engine = create_test_graph();
        // main -CALLS-> validate -READS_FROM-> User
        // This is a 2-segment pattern chain.
        let result = execute(
            &engine,
            "MATCH (f:FUNCTION)-[:CALLS]->(g:FUNCTION)-[:READS_FROM]->(c:CLASS) WHERE f.name = 'main' RETURN f.name, g.name, c.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["f.name", "g.name", "c.name"]);
        // main->validate->User is the only path where the intermediate is a FUNCTION
        // and the final target is a CLASS.
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!("main"));
        assert_eq!(result.rows[0][1], serde_json::json!("validate"));
        assert_eq!(result.rows[0][2], serde_json::json!("User"));
    }
}
