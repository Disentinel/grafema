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

    // ── Variable-length forms beyond `*min..max` (standard Cypher grammar) ──
    //
    // `parse_var_length` used to call `expect("..")` unconditionally, so the
    // unbounded `*` and exact-length `*N` forms were REJECTED with a parse error,
    // and the open-ended `*N..` / `*..` forms silently defaulted `max` to 10 —
    // a traversal that silently truncated at depth 10. These guard each form.

    #[test]
    fn variable_length_unbounded() {
        // Bare `*` = "one or more hops", no upper bound.
        let q = parse_cypher("MATCH (a)-[:CALLS*]->(b) RETURN b.name").unwrap();
        let (rel, _) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.length, Some((1, u32::MAX)));
    }

    #[test]
    fn variable_length_exact() {
        // `*3` = "exactly three hops" → (3, 3).
        let q = parse_cypher("MATCH (a)-[:CALLS*3]->(b) RETURN b.name").unwrap();
        let (rel, _) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.length, Some((3, 3)));
    }

    #[test]
    fn variable_length_min_unbounded() {
        // `*2..` = "at least two hops", no upper bound — NOT silently capped at 10.
        let q = parse_cypher("MATCH (a)-[:CALLS*2..]->(b) RETURN b.name").unwrap();
        let (rel, _) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.length, Some((2, u32::MAX)));
    }

    #[test]
    fn variable_length_max_only() {
        // `*..5` = "up to five hops", min defaults to 1.
        let q = parse_cypher("MATCH (a)-[:CALLS*..5]->(b) RETURN b.name").unwrap();
        let (rel, _) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.length, Some((1, 5)));
    }

    #[test]
    fn variable_length_open_both_ends() {
        // `*..` = "one or more hops" — equivalent to bare `*`.
        let q = parse_cypher("MATCH (a)-[:CALLS*..]->(b) RETURN b.name").unwrap();
        let (rel, _) = &q.match_clause.pattern.segments[0];
        assert_eq!(rel.length, Some((1, u32::MAX)));
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
    fn multibyte_char_where_keyword_expected_errors_not_panics() {
        // A multibyte UTF-8 char sitting where a keyword check happens must
        // produce a clean ParseError, not panic on a non-char-boundary byte
        // slice. Here, after `n.name = 'x'` the expression parser probes for
        // `OR`/`AND` (2/3-byte keywords) against a 3-byte char (好, U+597D).
        let multibyte = String::from_utf8(vec![0xE5, 0xA5, 0xBD]).unwrap();
        let query = format!("MATCH (n) WHERE n.name = 'x' {}", multibyte);
        let err = parse_cypher(&query).unwrap_err();
        assert!(
            err.message.contains("expected keyword 'RETURN'"),
            "unexpected message: {}",
            err.message
        );
    }

    #[test]
    fn multibyte_trailing_input_errors_not_panics() {
        // Trailing multibyte input after a complete query reaches the
        // `ORDER`/`LIMIT` keyword probes (5-byte keywords) against a 6-byte
        // run (ααα, three U+03B1). The byte index 5 lands mid-char.
        let multibyte = String::from_utf8(vec![0xCE, 0xB1, 0xCE, 0xB1, 0xCE, 0xB1]).unwrap();
        let query = format!("MATCH (n) RETURN n {}", multibyte);
        let err = parse_cypher(&query).unwrap_err();
        assert!(
            err.message.contains("unexpected input after query"),
            "unexpected message: {}",
            err.message
        );
    }

    #[test]
    fn multibyte_immediately_before_real_keyword_still_parses() {
        // Guard: a legitimate non-ASCII string literal followed by ORDER BY
        // must still parse — the boundary-safe keyword check must not regress
        // normal keyword detection.
        let cyrillic =
            String::from_utf8(vec![0xD1, 0x82, 0xD0, 0xB5, 0xD1, 0x81, 0xD1, 0x82]).unwrap(); // "тест"
        let query = format!(
            "MATCH (n) WHERE n.name = '{}' RETURN n.name ORDER BY n.name LIMIT 5",
            cyrillic
        );
        let q = parse_cypher(&query).unwrap();
        assert!(q.order_by.is_some());
        assert_eq!(q.limit, Some(5));
    }

    #[test]
    fn line_comment_ignored() {
        let q = parse_cypher(
            "// Find all functions\nMATCH (n:FUNCTION) RETURN n.name",
        )
        .unwrap();
        assert_eq!(q.match_clause.pattern.start.labels, vec!["FUNCTION".to_string()]);
    }

    #[test]
    fn limit_zero_parses() {
        // LIMIT 0 is a valid (if pointless) non-negative bound.
        let q = parse_cypher("MATCH (n:FUNCTION) RETURN n.name LIMIT 0").unwrap();
        assert_eq!(q.limit, Some(0));
    }

    #[test]
    fn negative_limit_rejected() {
        // A negative LIMIT must be a parse error, not silently wrapped to a huge
        // u64 (which would behave as "no limit" and return the entire result set).
        let err = parse_cypher("MATCH (n:FUNCTION) RETURN n.name LIMIT -1")
            .expect_err("LIMIT -1 must be rejected");
        let msg = format!("{}", err).to_lowercase();
        assert!(
            msg.contains("limit") && msg.contains("non-negative"),
            "expected a clear non-negative LIMIT error, got: {}",
            msg
        );

        // Larger negative values are rejected the same way.
        assert!(parse_cypher("MATCH (n:FUNCTION) RETURN n.name LIMIT -5").is_err());
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

    // ── Whole-node RETURN must carry analyzer metadata ───────────────────
    //
    // Returning a whole node (`RETURN n` / `RETURN *`) serializes it via
    // `CypherValue::to_json`. Grafema stores most node properties (line,
    // column, signature, params, visibility, …) in the `metadata` JSON blob,
    // and `property()` already treats those as first-class — `n.lineCount`
    // resolves to the metadata field. Faithful Cypher (and the AI-first
    // thesis: an agent inspects nodes by querying the graph) requires the
    // whole-node form to expose the SAME properties. Regression guard:
    // `to_json` previously emitted only the canonical columns (id/type/name/
    // file/exported/semanticId) and silently dropped every metadata field, so
    // `n.lineCount` worked but `RETURN n` came back without `lineCount`.

    #[test]
    fn return_whole_node_includes_metadata_properties() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'main'}) RETURN n",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 1);
        let node = result.rows[0][0]
            .as_object()
            .expect("RETURN n must serialize to a JSON object");

        // Canonical fields still present and authoritative.
        assert_eq!(node.get("name").and_then(|v| v.as_str()), Some("main"));
        assert_eq!(node.get("type").and_then(|v| v.as_str()), Some("FUNCTION"));
        assert_eq!(
            node.get("semanticId").and_then(|v| v.as_str()),
            Some("main@src/app.js")
        );

        // The bug: the `lineCount` metadata property must survive into the
        // whole-node object, preserving its numeric type (not stringified).
        assert_eq!(
            node.get("lineCount").and_then(|v| v.as_i64()),
            Some(42),
            "RETURN n must include metadata property lineCount, got {:?}",
            node
        );
    }

    #[test]
    fn return_whole_node_metadata_cannot_shadow_canonical_fields() {
        // A hostile/legacy metadata blob carries keys that collide with the
        // canonical node fields AND a genuine extra field. The canonical fields
        // must win (reserved keys skipped), while the non-reserved `visibility`
        // field is merged. Also exercises the graceful path for a node whose
        // metadata is NOT a JSON object (here a JSON array → ignored, no panic).
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            NodeRecord {
                id: 100,
                node_type: Some("FUNCTION".to_string()),
                name: Some("real".to_string()),
                file: Some("src/real.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: true,
                replaces: None,
                deleted: false,
                metadata: Some(
                    r#"{"name": "spoof", "type": "CLASS", "id": "999", "visibility": "public"}"#
                        .to_string(),
                ),
                semantic_id: Some("real@src/real.js".to_string()),
            },
            NodeRecord {
                id: 101,
                node_type: Some("FUNCTION".to_string()),
                name: Some("arrmeta".to_string()),
                file: Some("src/real.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"[1, 2, 3]"#.to_string()),
                semantic_id: None,
            },
        ]);

        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'real'}) RETURN n",
            EvalLimits::none(),
        )
        .unwrap();
        let node = result.rows[0][0].as_object().unwrap();
        // Canonical fields are authoritative — metadata cannot shadow them.
        assert_eq!(node.get("name").and_then(|v| v.as_str()), Some("real"));
        assert_eq!(node.get("type").and_then(|v| v.as_str()), Some("FUNCTION"));
        assert_eq!(node.get("id").and_then(|v| v.as_str()), Some("100"));
        // The genuine extra metadata field is merged.
        assert_eq!(node.get("visibility").and_then(|v| v.as_str()), Some("public"));

        // Non-object metadata is ignored without panicking; canonical fields stay.
        let arr = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'arrmeta'}) RETURN n",
            EvalLimits::none(),
        )
        .unwrap();
        let arr_node = arr.rows[0][0].as_object().unwrap();
        assert_eq!(arr_node.get("name").and_then(|v| v.as_str()), Some("arrmeta"));
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

    // ── Repeated-variable / self-join pattern tests ─────────────────────
    //
    // A node variable used twice in a MATCH pattern (e.g. `(a)-[:R]->(a)` or
    // `(m)-[:R1]->(c)-[:R2]->(m)`) must denote the SAME node: the second
    // occurrence is an equality constraint, not a fresh binding. The Expand /
    // VarLengthExpand operators must FILTER (keep only rows whose discovered
    // target equals the already-bound node), not overwrite the binding —
    // overwriting fabricates rows for non-existent self-loops / cycles. This
    // is the same self-join class as the Datalog hash-join shared-var guard.

    fn person(id: u128, name: &str) -> NodeRecord {
        NodeRecord {
            id,
            node_type: Some("PERSON".to_string()),
            name: Some(name.to_string()),
            file: Some("g".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".into(),
            exported: false,
            replaces: None,
            deleted: false,
            metadata: None,
            semantic_id: None,
        }
    }

    fn rel(src: u128, dst: u128, ty: &str) -> EdgeRecord {
        EdgeRecord {
            src,
            dst,
            edge_type: Some(ty.to_string()),
            version: "main".into(),
            metadata: None,
            deleted: false,
        }
    }

    #[test]
    fn expand_self_loop_repeated_var() {
        // alice -LOOPS-> alice (real self-loop); bob -LOOPS-> carol (not one).
        // `MATCH (a)-[:LOOPS]->(a)` must return ONLY alice.
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![person(1, "alice"), person(2, "bob"), person(3, "carol")]);
        engine.add_edges(vec![rel(1, 1, "LOOPS"), rel(2, 3, "LOOPS")], true);

        let res = crate::cypher::execute(
            &engine,
            "MATCH (a)-[:LOOPS]->(a) RETURN a.name",
            default_limits(),
        )
        .unwrap();

        let mut names: Vec<String> = res
            .rows
            .iter()
            .map(|r| r[0].as_str().unwrap_or("").to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["alice"],
            "self-loop pattern must bind `a` to the same node on both ends; bob->carol must not appear"
        );
    }

    #[test]
    fn expand_two_hop_cycle_repeated_var() {
        // Mutual: alice<->bob. One-way chain: carol->dave->erin.
        // `MATCH (m)-[:KNOWS]->(c)-[:KNOWS]->(m)` must return ONLY the mutual
        // pair, in both directions: (alice,bob) and (bob,alice).
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            person(1, "alice"),
            person(2, "bob"),
            person(3, "carol"),
            person(4, "dave"),
            person(5, "erin"),
        ]);
        engine.add_edges(
            vec![
                rel(1, 2, "KNOWS"),
                rel(2, 1, "KNOWS"),
                rel(3, 4, "KNOWS"),
                rel(4, 5, "KNOWS"),
            ],
            true,
        );

        let res = crate::cypher::execute(
            &engine,
            "MATCH (m)-[:KNOWS]->(c)-[:KNOWS]->(m) RETURN m.name, c.name",
            default_limits(),
        )
        .unwrap();

        let mut pairs: Vec<(String, String)> = res
            .rows
            .iter()
            .map(|r| {
                (
                    r[0].as_str().unwrap_or("").to_string(),
                    r[1].as_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("alice".to_string(), "bob".to_string()),
                ("bob".to_string(), "alice".to_string()),
            ],
            "two-hop cycle must close back to the same start node; the carol->dave->erin chain must not yield a row"
        );
    }

    #[test]
    fn varlength_expand_repeated_var_no_fabricated_rows() {
        // One-way chain alice->bob->carol; nothing returns to alice.
        // `MATCH (a)-[:KNOWS*1..2]->(a)` has no valid binding, so it must
        // return NOTHING — and must never rebind `a` to bob or carol.
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![person(1, "alice"), person(2, "bob"), person(3, "carol")]);
        engine.add_edges(vec![rel(1, 2, "KNOWS"), rel(2, 3, "KNOWS")], true);

        let res = crate::cypher::execute(
            &engine,
            "MATCH (a)-[:KNOWS*1..2]->(a) RETURN a.name",
            default_limits(),
        )
        .unwrap();

        assert!(
            res.rows.is_empty(),
            "variable-length repeated-var pattern must not fabricate rows by rebinding `a`; got {:?}",
            res.rows
        );
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

    /// Graph with a STRING metadata property `category` that is genuinely
    /// present on one FUNCTION node ("withcat" = "alpha") and absent (NULL) on
    /// two others ("nocat_none" has no metadata; "nocat_other" has metadata
    /// without the key). Used to exercise three-valued logic of the string
    /// predicates under NOT — `semanticId` cannot be used because NodeScan
    /// synthesizes a non-NULL semanticId for every node.
    fn create_string_metadata_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("FUNCTION".to_string()),
                name: Some("withcat".to_string()),
                file: Some("src/a.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: true,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"category": "alpha"}"#.to_string()),
                semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("FUNCTION".to_string()),
                name: Some("nocat_none".to_string()),
                file: Some("src/b.js".to_string()),
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
                node_type: Some("FUNCTION".to_string()),
                name: Some("nocat_other".to_string()),
                file: Some("src/c.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"other": 1}"#.to_string()),
                semantic_id: None,
            },
        ]);
        engine
    }

    /// Collect FUNCTION node names that pass `predicate` against the
    /// string-metadata fixture, sorted.
    fn filtered_names(predicate: Expr) -> Vec<String> {
        let engine = create_string_metadata_graph();
        let limits = default_limits();
        let scan = NodeScan::new(
            &engine,
            Some("n".to_string()),
            vec!["FUNCTION".to_string()],
            vec![],
            &limits,
        );
        let mut filter = Filter::new(Box::new(scan), predicate);
        let mut names = Vec::new();
        while let Some(rec) = filter.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("n").unwrap().property("name") {
                names.push(s);
            }
        }
        names.sort();
        names
    }

    /// Regression (three-valued logic): `WHERE NOT n.<prop> CONTAINS 'x'` must
    /// EXCLUDE nodes whose property is NULL (absent), matching Cypher/Neo4j
    /// semantics. Before the fix, CONTAINS returned `Bool(false)` for a NULL
    /// operand, and `NOT Bool(false)` is `Bool(true)`, so the row was wrongly
    /// admitted. Correct: `null CONTAINS 'x' = null`, `NOT null = null` (excluded).
    ///
    /// `NOT category CONTAINS 'a'` matches NOTHING: "withcat" ("alpha") contains
    /// 'a' (NOT -> false), and the two NULL-category nodes stay NULL.
    #[test]
    fn filter_not_contains_null_property_excluded() {
        let names = filtered_names(Expr::Not(Box::new(Expr::Contains(
            Box::new(Expr::Property("n".to_string(), "category".to_string())),
            Box::new(Expr::Literal(CypherLiteral::Str("a".to_string()))),
        ))));
        assert!(
            names.is_empty(),
            "NOT CONTAINS on a NULL property must exclude null-valued rows, got {:?}",
            names
        );
    }

    /// Sibling of `filter_not_contains_null_property_excluded` for STARTS WITH.
    #[test]
    fn filter_not_starts_with_null_property_excluded() {
        let names = filtered_names(Expr::Not(Box::new(Expr::StartsWith(
            Box::new(Expr::Property("n".to_string(), "category".to_string())),
            Box::new(Expr::Literal(CypherLiteral::Str("al".to_string()))),
        ))));
        assert!(
            names.is_empty(),
            "NOT STARTS WITH on a NULL property must exclude null-valued rows, got {:?}",
            names
        );
    }

    /// Sibling of `filter_not_contains_null_property_excluded` for ENDS WITH.
    #[test]
    fn filter_not_ends_with_null_property_excluded() {
        let names = filtered_names(Expr::Not(Box::new(Expr::EndsWith(
            Box::new(Expr::Property("n".to_string(), "category".to_string())),
            Box::new(Expr::Literal(CypherLiteral::Str("ha".to_string()))),
        ))));
        assert!(
            names.is_empty(),
            "NOT ENDS WITH on a NULL property must exclude null-valued rows, got {:?}",
            names
        );
    }

    /// Guard against over-correction: a direct (non-negated) CONTAINS on a NULL
    /// property still EXCLUDES the row (NULL is not truthy) and still matches the
    /// non-null hit. Passes both before and after the fix.
    #[test]
    fn filter_contains_null_property_still_excludes_and_matches() {
        let names = filtered_names(Expr::Contains(
            Box::new(Expr::Property("n".to_string(), "category".to_string())),
            Box::new(Expr::Literal(CypherLiteral::Str("a".to_string()))),
        ));
        assert_eq!(names, vec!["withcat"]);
    }

    /// Three-valued logic for ORDER-style comparisons over INCOMPARABLE (but
    /// non-NULL) operands. In the fixture, `withcat.category` is the string
    /// `"alpha"`. Comparing a String against an Int (`n.category < 5`) is
    /// incomparable, so per Cypher/Neo4j it must evaluate to NULL — not a
    /// definite `false`. Under `NOT`, NULL stays NULL and the row is EXCLUDED.
    ///
    /// Before the fix `eval_binop` returned `Bool(false)` for incomparable
    /// operands (`partial_cmp_values(..).unwrap_or(false)`), so
    /// `NOT (Str < Int)` became `NOT false = true` and wrongly admitted
    /// `withcat`. This is the incomparable-type sibling of the NULL-operand
    /// guard (#341) and the string-predicate / AND-OR NULL fixes (#348/#352).
    ///
    /// `NOT (category < 5)` must match NOTHING: `withcat` → `Str < Int` = NULL →
    /// `NOT NULL` = NULL (excluded); the two NULL-category nodes → `null < 5` =
    /// NULL → excluded.
    #[test]
    fn filter_not_lt_incomparable_types_excluded() {
        let names = filtered_names(Expr::Not(Box::new(Expr::BinaryOp(
            Box::new(Expr::Property("n".to_string(), "category".to_string())),
            BinOp::Lt,
            Box::new(Expr::Literal(CypherLiteral::Int(5))),
        ))));
        assert!(
            names.is_empty(),
            "NOT (String < Int) is incomparable -> NULL -> NOT NULL = NULL; row must be excluded, got {:?}",
            names
        );
    }

    /// Sibling of `filter_not_lt_incomparable_types_excluded` for `>=`.
    /// `NOT (category >= 5)` over `withcat` (`"alpha"` vs Int) must also be
    /// NULL → excluded, not `NOT false = true`.
    #[test]
    fn filter_not_gte_incomparable_types_excluded() {
        let names = filtered_names(Expr::Not(Box::new(Expr::BinaryOp(
            Box::new(Expr::Property("n".to_string(), "category".to_string())),
            BinOp::Gte,
            Box::new(Expr::Literal(CypherLiteral::Int(5))),
        ))));
        assert!(
            names.is_empty(),
            "NOT (String >= Int) is incomparable -> NULL; row must be excluded, got {:?}",
            names
        );
    }

    /// Guard against over-correction: a direct (non-negated) incomparable
    /// ordering still EXCLUDES the row (NULL is not truthy). Passes both before
    /// (false) and after (NULL) the fix — confirms top-level WHERE is unchanged.
    #[test]
    fn filter_lt_incomparable_types_still_excludes() {
        let names = filtered_names(Expr::BinaryOp(
            Box::new(Expr::Property("n".to_string(), "category".to_string())),
            BinOp::Lt,
            Box::new(Expr::Literal(CypherLiteral::Int(5))),
        ));
        assert!(
            names.is_empty(),
            "String < Int is incomparable -> not truthy; row must be excluded, got {:?}",
            names
        );
    }

    /// Guard: valid SAME-type ordering still works after the fix. String vs
    /// String (`category < 'b'`) is comparable: `"alpha" < "b"` is true, so
    /// `withcat` matches; the NULL-category nodes are excluded.
    #[test]
    fn filter_lt_same_type_strings_still_matches() {
        let names = filtered_names(Expr::BinaryOp(
            Box::new(Expr::Property("n".to_string(), "category".to_string())),
            BinOp::Lt,
            Box::new(Expr::Literal(CypherLiteral::Str("b".to_string()))),
        ));
        assert_eq!(names, vec!["withcat"]);
    }

    /// Guard: valid numeric ordering still works. `nocat_other` has `other = 1`
    /// (Int); `other > 0` is comparable and true, so it matches.
    #[test]
    fn filter_gt_same_type_numbers_still_matches() {
        let names = filtered_names(Expr::BinaryOp(
            Box::new(Expr::Property("n".to_string(), "other".to_string())),
            BinOp::Gt,
            Box::new(Expr::Literal(CypherLiteral::Int(0))),
        ));
        assert_eq!(names, vec!["nocat_other"]);
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

    /// Three-valued logic for the string predicates and `NOT`: a NULL operand
    /// yields NULL (not `Bool(false)`), and `NOT NULL` stays NULL (not
    /// `Bool(true)`). This is the mechanism behind `WHERE NOT x CONTAINS 'y'`
    /// correctly excluding rows where `x` is NULL.
    #[test]
    fn eval_expr_string_predicates_null_operand_yields_null() {
        let rec = Record::new(); // empty record: Variable("x") evaluates to NULL

        for pred in [
            Expr::Contains(
                Box::new(Expr::Variable("x".to_string())),
                Box::new(Expr::Literal(CypherLiteral::Str("y".to_string()))),
            ),
            Expr::StartsWith(
                Box::new(Expr::Variable("x".to_string())),
                Box::new(Expr::Literal(CypherLiteral::Str("y".to_string()))),
            ),
            Expr::EndsWith(
                Box::new(Expr::Variable("x".to_string())),
                Box::new(Expr::Literal(CypherLiteral::Str("y".to_string()))),
            ),
        ] {
            assert_eq!(eval_expr(&pred, &rec), CypherValue::Null);
            // NOT NULL must remain NULL (three-valued logic), not flip to true.
            let negated = Expr::Not(Box::new(pred));
            assert_eq!(eval_expr(&negated, &rec), CypherValue::Null);
        }

        // The NULL guard fires on EITHER operand: a NULL right-hand side too.
        let rhs_null = Expr::Contains(
            Box::new(Expr::Literal(CypherLiteral::Str("abc".to_string()))),
            Box::new(Expr::Variable("x".to_string())),
        );
        assert_eq!(eval_expr(&rhs_null, &rec), CypherValue::Null);
    }

    /// `NOT` on a definite boolean is unchanged: only the NULL arm is special.
    #[test]
    fn eval_expr_not_on_boolean_unchanged() {
        let rec = Record::new();
        let t = Expr::Not(Box::new(Expr::Literal(CypherLiteral::Bool(true))));
        assert_eq!(eval_expr(&t, &rec), CypherValue::Bool(false));
        let f = Expr::Not(Box::new(Expr::Literal(CypherLiteral::Bool(false))));
        assert_eq!(eval_expr(&f, &rec), CypherValue::Bool(true));
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

    /// Three-valued (Kleene) logic for `AND` under `NOT`. `n.category` is NULL
    /// for the two cat-less nodes, so `n.category CONTAINS 'a'` is NULL there.
    /// Kleene: `null AND true = null`; `NOT null = null` → excluded. Before the
    /// fix `AND` collapsed the NULL operand to `Bool(false)` via `is_truthy()`,
    /// so `NOT (null AND true)` became `NOT false = true` and wrongly admitted
    /// the two NULL-category rows. `withcat` ("alpha") → `true AND true = true`,
    /// `NOT true = false` → excluded. Correct result: nothing.
    #[test]
    fn filter_not_and_null_operand_excluded() {
        let names = filtered_names(Expr::Not(Box::new(Expr::And(
            Box::new(Expr::Contains(
                Box::new(Expr::Property("n".to_string(), "category".to_string())),
                Box::new(Expr::Literal(CypherLiteral::Str("a".to_string()))),
            )),
            Box::new(Expr::Literal(CypherLiteral::Bool(true))),
        ))));
        assert!(
            names.is_empty(),
            "NOT (nullPredicate AND true) must exclude NULL-operand rows (Kleene: null AND true = null), got {:?}",
            names
        );
    }

    /// Sibling of `filter_not_and_null_operand_excluded` for `OR`. Kleene:
    /// `null OR false = null`; `NOT null = null` → excluded. Before the fix
    /// `OR` collapsed the NULL operand to `Bool(false)`, so `NOT (null OR false)`
    /// became `NOT false = true` and wrongly admitted the NULL-category rows.
    #[test]
    fn filter_not_or_null_operand_excluded() {
        let names = filtered_names(Expr::Not(Box::new(Expr::Or(
            Box::new(Expr::Contains(
                Box::new(Expr::Property("n".to_string(), "category".to_string())),
                Box::new(Expr::Literal(CypherLiteral::Str("a".to_string()))),
            )),
            Box::new(Expr::Literal(CypherLiteral::Bool(false))),
        ))));
        assert!(
            names.is_empty(),
            "NOT (nullPredicate OR false) must exclude NULL-operand rows (Kleene: null OR false = null), got {:?}",
            names
        );
    }

    /// Guard: FALSE dominates `AND` even past a NULL operand (Kleene:
    /// `null AND false = false`). So `NOT (anything AND false) = NOT false =
    /// true` admits every row. Holds before and after the fix — proves the
    /// truthy/falsy short-circuits are preserved.
    #[test]
    fn filter_not_and_false_admits_all() {
        let names = filtered_names(Expr::Not(Box::new(Expr::And(
            Box::new(Expr::Contains(
                Box::new(Expr::Property("n".to_string(), "category".to_string())),
                Box::new(Expr::Literal(CypherLiteral::Str("a".to_string()))),
            )),
            Box::new(Expr::Literal(CypherLiteral::Bool(false))),
        ))));
        assert_eq!(names, vec!["nocat_none", "nocat_other", "withcat"]);
    }

    /// Guard: TRUE dominates `OR` even past a NULL operand (Kleene:
    /// `null OR true = true`). So `NOT (anything OR true) = NOT true = false`
    /// admits nothing. Holds before and after the fix.
    #[test]
    fn filter_not_or_true_excludes_all() {
        let names = filtered_names(Expr::Not(Box::new(Expr::Or(
            Box::new(Expr::Contains(
                Box::new(Expr::Property("n".to_string(), "category".to_string())),
                Box::new(Expr::Literal(CypherLiteral::Str("a".to_string()))),
            )),
            Box::new(Expr::Literal(CypherLiteral::Bool(true))),
        ))));
        assert!(names.is_empty(), "got {:?}", names);
    }

    /// Guard: a direct (non-negated) `AND` with a NULL operand still EXCLUDES
    /// the row (NULL is not truthy) and still matches the non-null hit. The bug
    /// is only observable under `NOT`; top-level `WHERE` filtering is unchanged.
    /// Holds before and after the fix.
    #[test]
    fn filter_and_null_operand_still_excludes_and_matches() {
        let names = filtered_names(Expr::And(
            Box::new(Expr::Contains(
                Box::new(Expr::Property("n".to_string(), "category".to_string())),
                Box::new(Expr::Literal(CypherLiteral::Str("a".to_string()))),
            )),
            Box::new(Expr::Literal(CypherLiteral::Bool(true))),
        ));
        assert_eq!(names, vec!["withcat"]);
    }

    /// Zero-length path: `min_depth = max_depth = 0` binds the destination to
    /// the START node itself (Cypher `*0` semantics). Was dropped by the
    /// `&& depth > 0` guard in `bfs`, which excluded depth 0 even for min 0.
    #[test]
    fn var_length_expand_zero_depth_yields_start() {
        let engine = create_test_graph();
        let limits = default_limits();

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
            0,
            0,
            &limits,
        );

        let mut names = Vec::new();
        while let Some(rec) = expand.next().unwrap() {
            if let CypherValue::Str(s) = rec.get("b").unwrap().property("name") {
                names.push(s);
            }
        }
        // Only the start node "main" — zero hops, no traversal.
        assert_eq!(names, vec!["main"]);
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

    // ── Anonymous start node + relationship ─────────────────────────────────
    //
    // Regression: a pattern whose FIRST node is anonymous (`MATCH ()-[:CALLS]->(g)`)
    // must still traverse edges. The planner synthesizes the source variable
    // `__anon_0` for the unnamed start node, but `NodeScan` only bound a record
    // field when the node had an explicit variable — so the produced record was
    // empty and `Expand` failed with "variable '__anon_0' is not a node".
    // Anonymous DESTINATION nodes were already bound (by `Expand`), so the gap
    // was specific to the start node. These cover outgoing, incoming, and the
    // edge-counting query (`MATCH ()-[r]->() RETURN COUNT(*)`) that surfaced it.

    #[test]
    fn anonymous_start_node_outgoing_traverses() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH ()-[:CALLS]->(g) RETURN g.name",
            EvalLimits::none(),
        )
        .unwrap();

        // CALLS edges: main->helper, main->validate, helper->validate.
        // Targets (g): helper, validate, validate.
        assert_eq!(result.row_count, 3);
        let names = collect_string_column(&result, 0);
        assert_eq!(names, vec!["helper", "validate", "validate"]);
    }

    #[test]
    fn anonymous_start_node_incoming_traverses() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH ()<-[:CALLS]-(caller) RETURN caller.name",
            EvalLimits::none(),
        )
        .unwrap();

        // Same CALLS edges read backwards — callers (sources): main, main, helper.
        assert_eq!(result.row_count, 3);
        let names = collect_string_column(&result, 0);
        assert_eq!(names, vec!["helper", "main", "main"]);
    }

    #[test]
    fn anonymous_start_node_count_edges() {
        // The exact dogfooding query that exposed the bug: counting edges with
        // both endpoints anonymous.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH ()-[:CALLS]->() RETURN COUNT(*) AS total",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["total"]);
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!(3));
    }

    #[test]
    fn anonymous_start_node_var_length_traverses() {
        // The same root cause affected `VarLengthExpand` (it resolves its source
        // node identically to `Expand`). A single-hop `*1..1` exercises that
        // operator deterministically (no BFS-dedup ambiguity).
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH ()-[:CALLS*1..1]->(g) RETURN g.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 3);
        let names = collect_string_column(&result, 0);
        assert_eq!(names, vec!["helper", "validate", "validate"]);
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

    /// Build a straight CALLS chain `n0 -> n1 -> ... -> n{len-1}`.
    fn create_chain_graph(len: u128) -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();
        let nodes: Vec<NodeRecord> = (0..len)
            .map(|i| NodeRecord {
                id: i + 1,
                node_type: Some("FUNCTION".to_string()),
                name: Some(format!("n{}", i)),
                file: Some("src/chain.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            })
            .collect();
        engine.add_nodes(nodes);

        let edges: Vec<EdgeRecord> = (0..len - 1)
            .map(|i| EdgeRecord {
                src: i + 1,
                dst: i + 2,
                edge_type: Some("CALLS".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            })
            .collect();
        engine.add_edges(edges, true);
        engine
    }

    #[test]
    fn variable_length_unbounded_reaches_beyond_depth_10() {
        // 15-node chain n0 -> n1 -> ... -> n14. Bare `*` must reach ALL 14
        // descendants of n0. Before the parse fix, `*` failed to parse at all;
        // the open-ended `*N..` form silently capped traversal at depth 10, so
        // n11..n14 vanished from results.
        let engine = create_chain_graph(15);
        let result = execute(
            &engine,
            "MATCH (a:FUNCTION)-[:CALLS*]->(b) WHERE a.name = 'n0' RETURN b.name",
            EvalLimits::none(),
        )
        .unwrap();

        let mut names = collect_string_column(&result, 0);
        names.sort();
        let mut expected: Vec<String> = (1..15).map(|i| format!("n{}", i)).collect();
        expected.sort();
        assert_eq!(names, expected, "bare `*` must reach all 14 descendants");
    }

    #[test]
    fn variable_length_min_unbounded_not_capped_at_10() {
        // `*12..` from n0 must reach n12, n13, n14 (depths 12,13,14) — depths the
        // old silent max-of-10 default excluded entirely.
        let engine = create_chain_graph(15);
        let result = execute(
            &engine,
            "MATCH (a:FUNCTION)-[:CALLS*12..]->(b) WHERE a.name = 'n0' RETURN b.name",
            EvalLimits::none(),
        )
        .unwrap();

        let mut names = collect_string_column(&result, 0);
        names.sort();
        assert_eq!(names, vec!["n12", "n13", "n14"]);
    }

    #[test]
    fn variable_length_exact_depth() {
        // `*5` from n0 is exactly n5 — no shorter, no longer.
        let engine = create_chain_graph(15);
        let result = execute(
            &engine,
            "MATCH (a:FUNCTION)-[:CALLS*5]->(b) WHERE a.name = 'n0' RETURN b.name",
            EvalLimits::none(),
        )
        .unwrap();

        let names = collect_string_column(&result, 0);
        assert_eq!(names, vec!["n5"]);
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

    // ── SUM / AVG / MIN / MAX aggregates (RFD-70) ───────────────────────

    /// Test graph with varied numeric `lineCount` metadata so SUM/AVG/MIN/MAX
    /// have real numeric inputs. One node deliberately has NO `lineCount` to
    /// exercise NULL-skipping (a missing metadata field evaluates to NULL).
    ///
    /// FUNCTION lineCounts: a=10, b=20, c=30, d=(none/NULL)
    fn create_numeric_test_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();
        let mk = |id: u128, name: &str, meta: Option<&str>| NodeRecord {
            id,
            node_type: Some("FUNCTION".to_string()),
            name: Some(name.to_string()),
            file: Some("src/m.js".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".into(),
            exported: true,
            replaces: None,
            deleted: false,
            metadata: meta.map(|s| s.to_string()),
            semantic_id: None,
        };
        engine.add_nodes(vec![
            mk(20, "a", Some(r#"{"lineCount": 10}"#)),
            mk(21, "b", Some(r#"{"lineCount": 20}"#)),
            mk(22, "c", Some(r#"{"lineCount": 30}"#)),
            mk(23, "d", None),
        ]);
        engine
    }

    #[test]
    fn sum_aggregate() {
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN SUM(n.lineCount) AS total",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["total"]);
        assert_eq!(result.row_count, 1);
        // 10 + 20 + 30 = 60, NULL skipped. NOT a COUNT (which would be 3 or 4).
        assert_eq!(result.rows[0][0], serde_json::json!(60));
    }

    #[test]
    fn avg_aggregate() {
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN AVG(n.lineCount) AS mean",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 1);
        // (10 + 20 + 30) / 3 = 20.0, NULL excluded from both sum and count.
        assert_eq!(result.rows[0][0].as_f64().unwrap(), 20.0);
    }

    #[test]
    fn min_aggregate() {
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN MIN(n.lineCount) AS lo",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!(10));
    }

    #[test]
    fn max_aggregate() {
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN MAX(n.lineCount) AS hi",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], serde_json::json!(30));
    }

    // ── WHERE comparisons with a NULL operand (Cypher three-valued logic) ──
    //
    // In Cypher, a comparison where either operand is NULL evaluates to NULL
    // (unknown), which is not truthy, so WHERE must EXCLUDE the row. Node `d`
    // has no `lineCount` property, so `d.lineCount` evaluates to NULL.
    //
    // Regression guard: `eval_binop` previously delegated ordering operators to
    // `partial_cmp_values`, which orders NULL as Less-than-everything — so
    // `null < 100` was `true` and wrongly ADMITTED `d`. Likewise `null <> 10`
    // returned `true` (via `!=`) and admitted `d`. Both must now exclude it.

    #[test]
    fn where_less_than_excludes_null_property() {
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.lineCount < 100 RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();

        let mut names: Vec<String> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap().to_string())
            .collect();
        names.sort();
        // d (no lineCount → NULL) must NOT appear: `null < 100` is NULL, not true.
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn where_lte_excludes_null_property() {
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.lineCount <= 100 RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();

        let mut names: Vec<String> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn where_not_equal_excludes_null_property() {
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.lineCount <> 10 RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();

        let mut names: Vec<String> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap().to_string())
            .collect();
        names.sort();
        // a excluded (10 <> 10 = false); d excluded (null <> 10 is NULL, not true).
        assert_eq!(names, vec!["b", "c"]);
    }

    #[test]
    fn where_greater_than_present_property_unaffected() {
        // Sanity: non-NULL operands keep working exactly as before.
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.lineCount > 15 RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();

        let mut names: Vec<String> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["b", "c"]);
    }

    #[test]
    fn sum_aggregate_grouped() {
        // Two groups by file, each with distinct numeric sums.
        let mut engine = GraphEngineV2::create_ephemeral();
        let mk = |id: u128, file: &str, lc: i64| NodeRecord {
            id,
            node_type: Some("FUNCTION".to_string()),
            name: Some(format!("f{}", id)),
            file: Some(file.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".into(),
            exported: true,
            replaces: None,
            deleted: false,
            metadata: Some(format!(r#"{{"lineCount": {}}}"#, lc)),
            semantic_id: None,
        };
        engine.add_nodes(vec![
            mk(30, "a.js", 1),
            mk(31, "a.js", 2),
            mk(32, "b.js", 10),
        ]);
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.file, SUM(n.lineCount) AS total",
            EvalLimits::none(),
        )
        .unwrap();

        let mut pairs: Vec<(String, i64)> = result
            .rows
            .iter()
            .map(|row| (row[0].as_str().unwrap().to_string(), row[1].as_i64().unwrap()))
            .collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![("a.js".to_string(), 3), ("b.js".to_string(), 10)]
        );
    }

    #[test]
    fn unsupported_aggregate_function_errors() {
        // A truly unsupported aggregate must error, not silently return a count.
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN STDDEV(n.lineCount) AS s",
            EvalLimits::none(),
        );
        assert!(
            result.is_err(),
            "expected error for unsupported aggregate, got {:?}",
            result
        );
    }

    // ── Aggregate-vs-scalar function routing (RFD-70 follow-up) ─────────

    #[test]
    fn scalar_function_in_return_rejected_not_mislabeled_aggregate() {
        // A non-aggregate function in RETURN must be rejected as an unsupported
        // FUNCTION — never silently routed through aggregation nor mislabeled as
        // an "aggregate". Only COUNT/SUM/AVG/MIN/MAX are aggregates.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN toUpper(n.name)",
            EvalLimits::none(),
        );
        assert!(result.is_err(), "expected an error for unsupported scalar function");
        let msg = format!("{:?}", result.unwrap_err()).to_lowercase();
        assert!(
            !msg.contains("aggregate"),
            "scalar function must not be reported as an aggregate; got: {}",
            msg
        );
        assert!(
            msg.contains("toupper") || msg.contains("function"),
            "error should name the unsupported function; got: {}",
            msg
        );
    }

    #[test]
    fn mixed_scalar_and_column_not_misaggregated() {
        // `RETURN n.file, toUpper(n.name)` must NOT be planned as GROUP BY n.file
        // with toUpper treated as an aggregate; it's rejected as unsupported.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.file, toUpper(n.name)",
            EvalLimits::none(),
        );
        assert!(result.is_err());
        let msg = format!("{:?}", result.unwrap_err()).to_lowercase();
        assert!(!msg.contains("aggregate"), "got: {}", msg);
    }

    #[test]
    fn real_aggregates_still_work_after_scalar_split() {
        // Regression: real aggregates + grouping unaffected by the scalar split.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (f:FUNCTION)-[:CALLS]->(g) RETURN f.name, COUNT(g) AS calls",
            EvalLimits::none(),
        )
        .unwrap();
        assert_eq!(result.columns, vec!["f.name", "calls"]);
        assert!(result.row_count >= 1);
    }

    // ── Unsupported scalar functions in WHERE / ORDER BY must fail loudly ──────
    //
    // The RETURN path already rejects unsupported scalar functions (see
    // `scalar_function_in_return_rejected_not_mislabeled_aggregate`). WHERE and
    // ORDER BY had no equivalent guard: a function the engine does not implement
    // (e.g. `toUpper`) evaluated to NULL in `eval_expr`, so a predicate like
    // `WHERE toUpper(n.name) = 'MAIN'` became `NULL = 'MAIN'` → NULL → not truthy
    // → every row silently dropped (an empty result that LOOKS like "no matches"),
    // and `ORDER BY toUpper(n.name)` made every sort key NULL → a silent no-op
    // sort. On-thesis silent-wrong-answer: the engine an AI agent queries must
    // fail loudly here, never return a confidently-wrong empty/unsorted result.

    #[test]
    fn where_unsupported_scalar_function_rejected_not_silent_empty() {
        // `toUpper` is not implemented. The matching node ("main") exists, so a
        // correct engine either evaluates the function or errors — it must NOT
        // silently return zero rows.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE toUpper(n.name) = 'MAIN' RETURN n.name",
            EvalLimits::none(),
        );
        assert!(
            result.is_err(),
            "unsupported scalar function in WHERE must error, not silently \
             return rows; got {:?}",
            result
        );
        let msg = format!("{:?}", result.unwrap_err()).to_lowercase();
        assert!(
            !msg.contains("aggregate"),
            "scalar function must not be reported as an aggregate; got: {}",
            msg
        );
        assert!(
            msg.contains("toupper") || msg.contains("function"),
            "error should name the unsupported function; got: {}",
            msg
        );
    }

    #[test]
    fn where_unsupported_scalar_function_nested_under_not_rejected() {
        // The guard must walk the whole predicate tree, not just the top node:
        // a scalar function buried under NOT/AND must still be rejected.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE NOT (toLower(n.name) = 'main' AND n.exported = true) RETURN n.name",
            EvalLimits::none(),
        );
        assert!(
            result.is_err(),
            "unsupported scalar function nested in WHERE must error; got {:?}",
            result
        );
    }

    #[test]
    fn order_by_unsupported_scalar_function_rejected() {
        // `ORDER BY toUpper(n.name)` would make every sort key NULL → silent
        // no-op sort. Must error instead.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name ORDER BY toUpper(n.name)",
            EvalLimits::none(),
        );
        assert!(
            result.is_err(),
            "unsupported scalar function in ORDER BY must error; got {:?}",
            result
        );
    }

    #[test]
    fn where_supported_string_predicate_still_works() {
        // Regression guard: CONTAINS is a built-in predicate (Expr::Contains),
        // NOT a FunctionCall, so the new guard must leave it untouched.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.name CONTAINS 'ain' RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();
        let names: Vec<String> = result
            .rows
            .iter()
            .map(|r| r[0].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["main".to_string()]);
    }

    #[test]
    fn inline_pattern_property_unsupported_function_rejected() {
        // `MATCH (n {name: toUpper('main')})` would evaluate the value to NULL
        // and match only NULL-named nodes → silent empty. Must error instead.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: toUpper('main')}) RETURN n.name",
            EvalLimits::none(),
        );
        assert!(
            result.is_err(),
            "unsupported scalar function in inline pattern property must error; got {:?}",
            result
        );
    }

    #[test]
    fn order_by_aggregate_in_aggregate_query_not_rejected() {
        // Regression guard: an AGGREGATE function (COUNT) in ORDER BY of an
        // aggregate query is legitimate and must NOT be rejected by the
        // scalar-function guard.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (f:FUNCTION)-[:CALLS]->(g) RETURN f.name, COUNT(g) AS calls ORDER BY COUNT(g)",
            EvalLimits::none(),
        );
        assert!(
            result.is_ok(),
            "aggregate function in ORDER BY must be allowed; got {:?}",
            result
        );
    }

    // ── GROUP BY key must distinguish value types (value_to_group_key) ─────
    //
    // `value_to_group_key` must map two values to the SAME bucket iff they are
    // equal under `CypherValue`'s `PartialEq` (the relation GROUP BY groups on).
    // The old implementation collapsed every variant to a bare `to_string()`,
    // so distinct-typed values that render to the same text — Int(5)/Str("5"),
    // Bool/Str, Null/Str("__null__") — were silently merged into ONE group,
    // corrupting aggregates. These tests pin the type-distinction (and guard
    // that Int(5) == Float(5.0) still groups together — no over-splitting).

    /// Build a graph of FUNCTION nodes whose `tag` metadata is injected verbatim
    /// as a JSON fragment, so each node's `n.tag` resolves to the exact
    /// `CypherValue` variant the test needs.
    fn graph_with_tags(tags: &[(u128, &str)]) -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();
        let nodes = tags
            .iter()
            .map(|(id, meta)| NodeRecord {
                id: *id,
                node_type: Some("FUNCTION".to_string()),
                name: Some(format!("f{}", id)),
                file: Some("src/m.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: true,
                replaces: None,
                deleted: false,
                metadata: Some(meta.to_string()),
                semantic_id: None,
            })
            .collect();
        engine.add_nodes(nodes);
        engine
    }

    #[test]
    fn group_key_int_and_string_do_not_collide() {
        // Int(5) and Str("5") are NOT equal under PartialEq → two groups.
        let engine = graph_with_tags(&[
            (40, r#"{"tag": 5}"#),   // n.tag -> Int(5)
            (41, r#"{"tag": "5"}"#), // n.tag -> Str("5")
        ]);
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.tag, COUNT(*) AS c",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(
            result.row_count, 2,
            "Int(5) and Str(\"5\") must form two distinct GROUP BY buckets, got rows: {:?}",
            result.rows
        );
        // Exactly one numeric-tag group and one string-tag group, each count 1.
        let mut counts: Vec<(bool, i64)> = result
            .rows
            .iter()
            .map(|row| (row[0].is_string(), row[1].as_i64().unwrap()))
            .collect();
        counts.sort();
        assert_eq!(counts, vec![(false, 1), (true, 1)]);
    }

    #[test]
    fn group_key_null_and_sentinel_string_do_not_collide() {
        // A missing property -> Null; a literal Str("__null__") must not share
        // the Null bucket (the old "__null__" sentinel collided with it).
        let engine = graph_with_tags(&[
            (42, r#"{"other": 1}"#),        // no `tag` -> n.tag = Null
            (43, r#"{"tag": "__null__"}"#), // n.tag -> Str("__null__")
        ]);
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.tag, COUNT(*) AS c",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(
            result.row_count, 2,
            "Null and Str(\"__null__\") must not collide, got rows: {:?}",
            result.rows
        );
    }

    #[test]
    fn group_key_bool_and_string_do_not_collide() {
        // Bool(true) and Str("true") are NOT equal under PartialEq → two groups.
        let engine = graph_with_tags(&[
            (46, r#"{"tag": true}"#),    // n.tag -> Bool(true)
            (47, r#"{"tag": "true"}"#),  // n.tag -> Str("true")
        ]);
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.tag, COUNT(*) AS c",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(
            result.row_count, 2,
            "Bool(true) and Str(\"true\") must not collide, got rows: {:?}",
            result.rows
        );
    }

    #[test]
    fn group_key_int_and_equal_float_still_group() {
        // Guard against over-splitting: Int(5) == Float(5.0) under PartialEq, so
        // they MUST stay in one group (Int/Float share the numeric namespace).
        let engine = graph_with_tags(&[
            (44, r#"{"tag": 5}"#),   // Int(5)
            (45, r#"{"tag": 5.0}"#), // Float(5.0)
        ]);
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.tag, COUNT(*) AS c",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(
            result.row_count, 1,
            "Int(5) and Float(5.0) are equal and must share one group, got rows: {:?}",
            result.rows
        );
        assert_eq!(result.rows[0][1].as_i64().unwrap(), 2);
    }


    /// Parse `cypher_literal` (the raw Cypher source text of a string literal,
    /// e.g. `r"'it\'s'"`) inside an inline node property and return the decoded
    /// string value the parser produced.
    fn parsed_string_literal(cypher_literal: &str) -> String {
        let query = format!("MATCH (n {{name: {}}}) RETURN n", cypher_literal);
        let q = parse_cypher(&query).unwrap();
        match &q.match_clause.pattern.start.properties[0].1 {
            Expr::Literal(CypherLiteral::Str(s)) => s.clone(),
            other => panic!("expected string literal, got {:?}", other),
        }
    }

    #[test]
    fn string_escape_single_quote_decoded() {
        // `'it\'s'` must decode to `it's` (the backslash is removed, the quote
        // does not terminate the string). Previously the raw `it\'s` — backslash
        // retained — was returned.
        assert_eq!(parsed_string_literal(r"'it\'s'"), "it's");
    }

    #[test]
    fn string_escape_double_quote_decoded() {
        // `"she said \"hi\""` decodes to `she said "hi"`.
        assert_eq!(
            parsed_string_literal(r#""she said \"hi\"""#),
            "she said \"hi\""
        );
    }

    #[test]
    fn string_escape_backslash_decoded() {
        // `'a\\b'` decodes to a single backslash: `a\b`.
        assert_eq!(parsed_string_literal(r"'a\\b'"), "a\\b");
    }

    #[test]
    fn string_escape_newline_and_tab_decoded() {
        assert_eq!(parsed_string_literal(r"'line\nbreak'"), "line\nbreak");
        assert_eq!(parsed_string_literal(r"'a\tb'"), "a\tb");
    }

    #[test]
    fn string_escape_unicode_decoded() {
        // `\u0041` is the Unicode escape for `A`.
        assert_eq!(parsed_string_literal(r"'\u0041BC'"), "ABC");
    }

    #[test]
    fn string_unknown_escape_preserved_verbatim() {
        // `\d` is not a defined escape; conservatively preserve `\d` so only
        // well-defined escapes change behavior.
        assert_eq!(parsed_string_literal(r"'a\db'"), "a\\db");
    }

    #[test]
    fn string_no_escape_unchanged() {
        // The common case (no backslash) is byte-for-byte unchanged.
        assert_eq!(parsed_string_literal("'plain text'"), "plain text");
    }

    #[test]
    fn where_string_literal_with_escaped_quote_matches() {
        // End-to-end: a node whose name literally contains an apostrophe must be
        // matched by a WHERE comparison whose Cypher string literal uses an
        // escaped quote. Before escape decoding the literal parsed as `it\'s`
        // (backslash retained) and matched nothing (0 rows).
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![NodeRecord {
            id: 1,
            node_type: Some("FUNCTION".to_string()),
            name: Some("it's".to_string()),
            file: Some("src/a.js".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".into(),
            exported: false,
            replaces: None,
            deleted: false,
            metadata: None,
            semantic_id: None,
        }]);

        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) WHERE n.name = 'it\\'s' RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(collect_string_column(&result, 0), vec!["it's"]);
    }

    // ── ORDER BY in aggregate queries (sort by aggregate / group-key expr) ──

    /// Three files with distinct grouped SUMs, laid out so that the group
    /// insertion order (a.js, m.js, z.js — ascending node id) matches NONE of
    /// the sorted orders we assert below. This makes the tests fail reliably
    /// when ORDER BY silently no-ops (rows fall back to insertion order),
    /// regardless of the storage scan order.
    ///
    /// Grouped SUM(lineCount): a.js=10, m.js=100, z.js=1.
    fn order_by_agg_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();
        let mk = |id: u128, file: &str, lc: i64| NodeRecord {
            id,
            node_type: Some("FUNCTION".to_string()),
            name: Some(format!("f{}", id)),
            file: Some(file.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".into(),
            exported: true,
            replaces: None,
            deleted: false,
            metadata: Some(format!(r#"{{"lineCount": {}}}"#, lc)),
            semantic_id: None,
        };
        engine.add_nodes(vec![
            mk(20, "a.js", 5),
            mk(21, "a.js", 5),
            mk(22, "m.js", 100),
            mk(23, "z.js", 1),
        ]);
        engine
    }

    #[test]
    fn order_by_aggregate_expression_sorts_groups() {
        // ORDER BY <aggregate function> in an aggregate query must sort by the
        // computed aggregate. The Sort operator runs on HashAggregate output
        // (columns keyed "n.file" / "total"); evaluating the raw FunctionCall
        // expr returns NULL post-aggregation, so without a rewrite every row
        // compares equal and the result stays in group-insertion order.
        let engine = order_by_agg_graph();

        let asc = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.file, SUM(n.lineCount) AS total ORDER BY SUM(n.lineCount) ASC",
            EvalLimits::none(),
        )
        .unwrap();
        let asc_totals: Vec<i64> = asc.rows.iter().map(|r| r[1].as_i64().unwrap()).collect();
        let asc_files: Vec<&str> = asc.rows.iter().map(|r| r[0].as_str().unwrap()).collect();
        assert_eq!(asc_totals, vec![1, 10, 100], "totals must be ascending");
        assert_eq!(asc_files, vec!["z.js", "a.js", "m.js"]);

        let desc = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.file, SUM(n.lineCount) AS total ORDER BY SUM(n.lineCount) DESC",
            EvalLimits::none(),
        )
        .unwrap();
        let desc_totals: Vec<i64> = desc.rows.iter().map(|r| r[1].as_i64().unwrap()).collect();
        assert_eq!(desc_totals, vec![100, 10, 1], "totals must be descending");
    }

    #[test]
    fn order_by_aliased_aggregate_sorts_groups() {
        // ORDER BY the aggregate's alias must also sort (this already worked via
        // the Variable lookup path, but is asserted to lock in the behavior).
        let engine = order_by_agg_graph();
        let res = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.file, SUM(n.lineCount) AS total ORDER BY total DESC",
            EvalLimits::none(),
        )
        .unwrap();
        let totals: Vec<i64> = res.rows.iter().map(|r| r[1].as_i64().unwrap()).collect();
        assert_eq!(totals, vec![100, 10, 1]);
    }

    #[test]
    fn order_by_group_key_property_in_aggregate_query() {
        // Sibling case: ORDER BY a group-key PROPERTY (n.file) in an aggregate
        // query. Post-aggregation node `n` is gone and the column is keyed
        // "n.file"; the raw Property("n","file") expr looked up absent var `n`,
        // yielding NULL and no sort. Assert both directions so insertion order
        // (which equals at most one of them) cannot satisfy both.
        let engine = order_by_agg_graph();

        let asc = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.file, SUM(n.lineCount) AS total ORDER BY n.file ASC",
            EvalLimits::none(),
        )
        .unwrap();
        let asc_files: Vec<&str> = asc.rows.iter().map(|r| r[0].as_str().unwrap()).collect();
        assert_eq!(asc_files, vec!["a.js", "m.js", "z.js"]);

        let desc = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.file, SUM(n.lineCount) AS total ORDER BY n.file DESC",
            EvalLimits::none(),
        )
        .unwrap();
        let desc_files: Vec<&str> = desc.rows.iter().map(|r| r[0].as_str().unwrap()).collect();
        assert_eq!(desc_files, vec!["z.js", "m.js", "a.js"]);
    }

    // ── ORDER BY a RETURN alias in a non-aggregate query ──────────────────
    //
    // In the non-aggregate path the planner runs Sort BEFORE Project, so Sort
    // sees the full pattern record (node bound to `n`) but NOT the RETURN
    // aliases (which Project creates afterwards). `ORDER BY <alias>` is parsed
    // as `Variable(alias)`; evaluating it against the pre-projection record
    // yields NULL for every row, so the rows fall back to scan/insertion order
    // and the ORDER BY silently no-ops. The fix rewrites alias references in
    // ORDER BY to the underlying RETURN expression so Sort can evaluate them.
    //
    // The three FUNCTION nodes are inserted as main, helper, validate (id
    // 10,11,12). Alphabetical ASC is helper,main,validate and DESC is
    // validate,main,helper — neither equals insertion order, so a no-op sort
    // cannot satisfy either assertion.

    #[test]
    fn order_by_alias_ascending_non_aggregate() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name AS nm ORDER BY nm",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["nm"]);
        let names: Vec<&str> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["helper", "main", "validate"]);
    }

    #[test]
    fn order_by_alias_descending_non_aggregate() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name AS nm ORDER BY nm DESC",
            EvalLimits::none(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["nm"]);
        let names: Vec<&str> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["validate", "main", "helper"]);
    }

    #[test]
    fn order_by_alias_with_limit_non_aggregate() {
        // The alias rewrite must compose with LIMIT: sort first, then take 2.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name AS nm ORDER BY nm DESC LIMIT 2",
            EvalLimits::none(),
        )
        .unwrap();

        let names: Vec<&str> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["validate", "main"]);
    }

    #[test]
    fn order_by_plain_property_still_works_non_aggregate() {
        // Regression guard: ORDER BY a raw property (no alias indirection) must
        // keep working — the rewrite must leave non-alias terms untouched.
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name AS nm ORDER BY n.name DESC",
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
    fn negative_limit_does_not_return_full_result_set() {
        // Regression: `LIMIT -1` was parsed to i64 -1 then cast `as u64`, yielding
        // u64::MAX — so the Limit operator never stopped and the query silently
        // returned EVERY row instead of erroring. An agent that computes a limit
        // and accidentally passes a negative value would get the whole graph back
        // dressed up as a capped result. The fix rejects negative LIMIT at parse
        // time, so execution surfaces a loud error rather than wrong data.
        let engine = create_test_graph();

        // Baseline: there is more than one FUNCTION node, so an unbounded scan
        // returns multiple rows. This makes the "returned everything" failure
        // mode observable.
        let all = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name",
            EvalLimits::none(),
        )
        .unwrap();
        assert!(
            all.row_count > 1,
            "fixture must have >1 FUNCTION node for this test to be meaningful"
        );

        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name LIMIT -1",
            EvalLimits::none(),
        );
        assert!(
            result.is_err(),
            "negative LIMIT must error, not return {} rows",
            result.map(|r| r.row_count).unwrap_or(0)
        );
    }

    // ── ORDER BY null ordering (Cypher/Neo4j semantics) ─────────────────
    //
    // Cypher treats null as GREATER than any non-null value for ordering:
    // nulls sort LAST in ascending order and FIRST in descending order
    // (Neo4j Cypher manual, "Ordering null"). The numeric fixture has one
    // node (`d`) with no `lineCount`, so `n.lineCount` is NULL for it.

    #[test]
    fn order_by_nulls_last_ascending() {
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name, n.lineCount ORDER BY n.lineCount",
            EvalLimits::none(),
        )
        .unwrap();

        let names: Vec<&str> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap())
            .collect();
        // a=10, b=20, c=30 ascending, then d (NULL lineCount) LAST.
        assert_eq!(names, vec!["a", "b", "c", "d"]);
        // The trailing row really is the NULL one (projects to JSON null).
        assert_eq!(result.rows[3][1], serde_json::Value::Null);
    }

    #[test]
    fn order_by_nulls_first_descending() {
        let engine = create_numeric_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION) RETURN n.name, n.lineCount ORDER BY n.lineCount DESC",
            EvalLimits::none(),
        )
        .unwrap();

        let names: Vec<&str> = result
            .rows
            .iter()
            .map(|row| row[0].as_str().unwrap())
            .collect();
        // d (NULL lineCount) FIRST, then c=30, b=20, a=10 descending.
        assert_eq!(names, vec!["d", "c", "b", "a"]);
        assert_eq!(result.rows[0][1], serde_json::Value::Null);
    }

    // ── Zero-length variable-length paths (`*0`, `*0..N`) ────────────────────
    //
    // openCypher/Neo4j: a variable-length pattern with a lower bound of 0
    // includes the ZERO-length path, which binds the destination variable to
    // the START node itself (the node is "reachable from itself in 0 hops").
    // `VarLengthExpand::bfs` dropped depth-0 unconditionally (`&& depth > 0`),
    // so `*0` / `*0..N` silently omitted the start node — a silent-wrong-answer
    // for the common "self-or-descendants" idiom (e.g. `-[:CONTAINS*0..]->`).

    /// `*0` is exactly the zero-length path: x is bound to the start node and
    /// nothing else. Was: empty result.
    #[test]
    fn var_length_zero_exact_returns_start_node() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'main'})-[:CALLS*0]->(x) RETURN x.name",
            EvalLimits::none(),
        )
        .unwrap();
        assert_eq!(collect_string_column(&result, 0), vec!["main"]);
    }

    /// `*0..1` = the start node (0 hops) PLUS its direct CALLS targets (1 hop).
    /// main -> helper, main -> validate, so the set is {main, helper, validate}.
    /// Was: {helper, validate} (start node missing).
    #[test]
    fn var_length_zero_to_one_includes_start_and_neighbors() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'main'})-[:CALLS*0..1]->(x) RETURN x.name",
            EvalLimits::none(),
        )
        .unwrap();
        assert_eq!(
            collect_string_column(&result, 0),
            vec!["helper", "main", "validate"]
        );
    }

    /// A destination label/property filter still applies to the zero-length
    /// match: `(x:CLASS)` excludes the FUNCTION start node, so `*0..1` here
    /// yields nothing (main has no CALLS edge to a CLASS, and main itself is
    /// not a CLASS).
    #[test]
    fn var_length_zero_respects_destination_label_filter() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'main'})-[:CALLS*0..1]->(x:CLASS) RETURN x.name",
            EvalLimits::none(),
        )
        .unwrap();
        assert!(
            result.rows.is_empty(),
            "zero-length match must honor destination label filter, got {:?}",
            result.rows
        );
    }

    /// Regression guard: a NON-zero lower bound must STILL exclude the start
    /// node. Removing the buggy `&& depth > 0` must not leak the start node into
    /// `*1..N` queries (depth 0 < min_depth already excludes it).
    #[test]
    fn var_length_min_one_still_excludes_start_node() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'main'})-[:CALLS*1..2]->(x) RETURN x.name",
            EvalLimits::none(),
        )
        .unwrap();
        // 1 hop: helper, validate. 2 hops: validate (via helper). De-duped set
        // excludes "main" — the start node must not appear for a min>=1 path.
        assert_eq!(
            collect_string_column(&result, 0),
            vec!["helper", "validate"]
        );
    }

    /// Headline idiom: `*0..` ("the node itself plus everything reachable").
    /// From "main" over CALLS this is {main, helper, validate} — the start node
    /// included via the zero-length path. Also proves the unbounded BFS still
    /// terminates (visited-set de-dup) with a zero lower bound. Was: start node
    /// missing.
    #[test]
    fn var_length_zero_unbounded_includes_self_and_all_reachable() {
        let engine = create_test_graph();
        let result = execute(
            &engine,
            "MATCH (n:FUNCTION {name: 'main'})-[:CALLS*0..]->(x) RETURN x.name",
            EvalLimits::none(),
        )
        .unwrap();
        assert_eq!(
            collect_string_column(&result, 0),
            vec!["helper", "main", "validate"]
        );
    }
}


// ─── RETURN * (project all named variables) ──────────────────────────────────
//
// `RETURN *` is a core Cypher idiom: it projects every variable bound in the
// MATCH pattern. Before the fix it parsed to a single `Expr::Star` return item
// that `eval_expr` evaluated to NULL, so `MATCH (n:CLASS) RETURN *` silently
// returned one column literally named "*" holding NULL instead of the node `n`
// — an on-thesis silent-wrong-answer for an AI agent querying the graph.
mod return_star_tests {
    use super::*;
    use crate::graph::GraphEngineV2;
    use crate::storage::{NodeRecord, EdgeRecord};
    use crate::datalog::EvalLimits;

    fn mkn(id: u128, ntype: &str, name: &str) -> NodeRecord {
        NodeRecord {
            id, node_type: Some(ntype.to_string()), name: Some(name.to_string()),
            file: Some("src/m.js".to_string()), file_id: 0, name_offset: 0,
            version: "main".into(), exported: true, replaces: None, deleted: false,
            metadata: None, semantic_id: None,
        }
    }
    fn mke(src: u128, dst: u128, t: &str) -> EdgeRecord {
        EdgeRecord {
            src, dst, edge_type: Some(t.to_string()),
            version: "main".into(), deleted: false, metadata: None,
        }
    }
    fn graph() -> GraphEngineV2 {
        let mut e = GraphEngineV2::create_ephemeral();
        e.add_nodes(vec![
            mkn(10, "CLASS", "User"),
            mkn(11, "FUNCTION", "main"),
            mkn(12, "FUNCTION", "helper"),
            mkn(13, "FUNCTION", "validate"),
        ]);
        e.add_edges(vec![
            mke(11, 12, "CALLS"),
            mke(11, 13, "CALLS"),
        ], false);
        e
    }

    fn obj_name(v: &serde_json::Value) -> String {
        v.get("name").and_then(|n| n.as_str()).unwrap_or("<none>").to_string()
    }

    #[test]
    fn return_star_projects_single_named_node_variable() {
        let e = graph();
        let r = execute(&e, "MATCH (n:CLASS) RETURN *", EvalLimits::none()).unwrap();
        // Column is the variable name `n`, NOT the literal "*".
        assert_eq!(r.columns, vec!["n"]);
        assert_eq!(r.row_count, 1);
        // The value is the whole node object, not NULL.
        assert!(r.rows[0][0].is_object(), "expected node object, got {:?}", r.rows[0][0]);
        assert_eq!(obj_name(&r.rows[0][0]), "User");
    }

    #[test]
    fn return_star_projects_all_named_variables_in_pattern_order() {
        let e = graph();
        let r = execute(
            &e,
            "MATCH (a:FUNCTION {name:'main'})-[:CALLS]->(b:FUNCTION) RETURN *",
            EvalLimits::none(),
        ).unwrap();
        assert_eq!(r.columns, vec!["a", "b"]);
        assert_eq!(r.row_count, 2);
        for row in &r.rows {
            assert_eq!(obj_name(&row[0]), "main");
            assert!(["helper", "validate"].contains(&obj_name(&row[1]).as_str()));
        }
    }

    #[test]
    fn return_star_includes_relationship_variable() {
        let e = graph();
        let r = execute(
            &e,
            "MATCH (a:FUNCTION {name:'main'})-[r:CALLS]->(b) RETURN *",
            EvalLimits::none(),
        ).unwrap();
        assert_eq!(r.columns, vec!["a", "r", "b"]);
        assert_eq!(r.row_count, 2);
    }

    #[test]
    fn return_star_with_no_named_variables_errors() {
        let e = graph();
        // No named variable anywhere in the pattern → `RETURN *` has nothing to project.
        let r = execute(&e, "MATCH ()-[:CALLS]->() RETURN *", EvalLimits::none());
        assert!(r.is_err(), "RETURN * with no named variables must error, got {:?}", r);
    }

    #[test]
    fn return_star_aliased_errors() {
        let e = graph();
        // `RETURN * AS x` is not valid Cypher.
        let r = execute(&e, "MATCH (n:CLASS) RETURN * AS x", EvalLimits::none());
        assert!(r.is_err(), "RETURN * AS x must error, got {:?}", r);
    }

    #[test]
    fn return_star_with_order_by_and_limit() {
        let e = graph();
        // Sort runs before Project, so ORDER BY on a star-projected variable's
        // property must still work (the full record is in scope at Sort time).
        let r = execute(
            &e,
            "MATCH (n:FUNCTION) RETURN * ORDER BY n.name ASC LIMIT 2",
            EvalLimits::none(),
        ).unwrap();
        assert_eq!(r.columns, vec!["n"]);
        assert_eq!(r.row_count, 2);
        assert_eq!(obj_name(&r.rows[0][0]), "helper");
        assert_eq!(obj_name(&r.rows[1][0]), "main");
    }

    #[test]
    fn count_star_still_works_after_star_expansion() {
        let e = graph();
        // Regression guard: count(*) must NOT be treated as RETURN *.
        let r = execute(&e, "MATCH (n:FUNCTION) RETURN count(*) AS c", EvalLimits::none()).unwrap();
        assert_eq!(r.columns, vec!["c"]);
        assert_eq!(r.row_count, 1);
        assert_eq!(r.rows[0][0], serde_json::json!(3));
    }

}
